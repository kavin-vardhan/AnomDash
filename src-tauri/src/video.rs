use std::collections::HashMap;
use std::ffi::c_void;
use std::fs;
use std::io::Cursor;
use std::os::windows::ffi::OsStrExt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use image::imageops::FilterType;
use image::{DynamicImage, ImageReader};
use windows::core::{s, w, Interface, HRESULT, PCSTR, PCWSTR};
use windows::Win32::Foundation::{E_POINTER, HMODULE, REGDB_E_CLASSNOTREG};
use windows::Win32::Media::MediaFoundation::{
    eAVEncH264VProfile_High, CODECAPI_AVEncMPVDefaultBPictureCount, IMFAttributes, IMFByteStream,
    IMFMediaBuffer, IMFMediaType, IMFSample, IMFSinkWriter, MFMediaType_Video,
    MFNominalRange_16_235, MFTranscodeContainerType_MPEG4, MFVideoFormat_H264, MFVideoFormat_NV12,
    MFVideoInterlace_Progressive, MFVideoPrimaries_BT709, MFVideoTransFunc_709,
    MFVideoTransferMatrix_BT709, MFSTARTUP_FULL, MF_ACCESSMODE_READWRITE,
    MF_E_TOPO_CODEC_NOT_FOUND, MF_FILEFLAGS_NONE, MF_FILE_ACCESSMODE, MF_FILE_FLAGS,
    MF_FILE_OPENMODE, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE,
    MF_MT_FIXED_SIZE_SAMPLES, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
    MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SAMPLE_SIZE,
    MF_MT_SUBTYPE, MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES,
    MF_MT_YUV_MATRIX, MF_OPENMODE_DELETE_IF_EXIST, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    MF_SINK_WRITER_DISABLE_THROTTLING, MF_TRANSCODE_CONTAINERTYPE, MF_VERSION,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
};

pub struct VideoJob {
    pub frames_dir: std::path::PathBuf,
    pub out_path: std::path::PathBuf,
    pub fps: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VideoReport {
    pub frames: u32,
    pub filled_gaps: u32,
    pub width: u32,
    pub height: u32,
    pub encoded_width: u32,
    pub encoded_height: u32,
    pub fps: f64,
    pub bytes: u64,
}

const CANCELLED: &str = "cancelled";
const ENCODER_UNAVAILABLE: &str = "Windows video encoder unavailable (Media Feature Pack missing?)";
const HNS_PER_SECOND: u128 = 10_000_000;
const PROGRESS_EVERY: u32 = 5;
const FILE_RETRY_LIMIT: Duration = Duration::from_secs(3);

const Y_R: i32 = 11966;
const Y_G: i32 = 40254;
const Y_B: i32 = 4064;
const CB_R: i32 = -6596;
const CB_G: i32 = -22188;
const CB_B: i32 = 28784;
const CR_R: i32 = 28784;
const CR_G: i32 = -26145;
const CR_B: i32 = -2639;
const LUMA_BLACK: u8 = 16;
const CHROMA_NEUTRAL: u8 = 128;
const MIN_ENCODED_SIDE: u32 = 34;
const MAX_ENCODER_MACROBLOCKS: u64 = 36_864;

pub fn encode_mp4(
    job: &VideoJob,
    progress: &(dyn Fn(u32, u32) + Sync),
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<VideoReport, String> {
    let rate = FrameRate::from_fps(job.fps)?;
    let frames = scan_frames(&job.frames_dir)?;
    let total = match frames.last() {
        Some((last, _)) => last + 1,
        None => return Err(format!(
            "No frames found in {} (expected files named like frame_00000.png or frame_00000.jpg)",
            job.frames_dir.display()
        )),
    };
    if cancel.load(Ordering::SeqCst) {
        return Err(CANCELLED.to_string());
    }
    let paths = OutputPaths::prepare(&job.out_path)?;
    progress(0, total);
    let outcome = encode_with_media_foundation(&frames, total, rate, &paths, progress, cancel);
    match outcome {
        Ok(mut report) => {
            if let Err(e) = paths.publish() {
                paths.discard();
                return Err(e);
            }
            report.bytes = fs::metadata(&paths.final_path)
                .map(|m| m.len())
                .unwrap_or(0);
            progress(total, total);
            Ok(report)
        }
        Err(e) => {
            paths.discard();
            Err(e)
        }
    }
}

#[derive(Clone, Copy)]
struct FrameRate {
    num: u32,
    den: u32,
}

impl FrameRate {
    fn from_fps(fps: f64) -> Result<Self, String> {
        if !fps.is_finite() || !(1.0..=240.0).contains(&fps) {
            return Err(format!(
                "The frame rate must be between 1 and 240 frames per second (got {})",
                fps
            ));
        }
        let num = (fps * 1000.0).round() as u64;
        let den = 1000u64;
        let g = gcd(num, den);
        Ok(FrameRate {
            num: (num / g) as u32,
            den: (den / g) as u32,
        })
    }

    fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    fn packed(self) -> u64 {
        pack(self.num, self.den)
    }

    fn time_of(self, index: u64) -> i64 {
        let n = self.num as u128;
        ((index as u128 * HNS_PER_SECOND * self.den as u128 + n / 2) / n) as i64
    }
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a.max(1)
}

fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

fn scan_frames(dir: &Path) -> Result<Vec<(u32, PathBuf)>, String> {
    if !dir.is_dir() {
        return Err(format!(
            "The frames folder {} does not exist",
            dir.display()
        ));
    }
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Cannot open the frames folder {}: {}", dir.display(), e))?;
    let mut found: HashMap<u32, (u8, PathBuf)> = HashMap::new();
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some((index, rank)) = parse_frame_name(name) else {
            continue;
        };
        let path = entry.path();
        match found.get(&index) {
            Some((existing, _)) if *existing <= rank => {}
            _ => {
                found.insert(index, (rank, path));
            }
        }
    }
    let mut frames: Vec<(u32, PathBuf)> = found.into_iter().map(|(i, (_, p))| (i, p)).collect();
    frames.sort_by_key(|(i, _)| *i);
    Ok(frames)
}

fn parse_frame_name(name: &str) -> Option<(u32, u8)> {
    let lower = name.to_ascii_lowercase();
    let rest = lower.strip_prefix("frame_")?;
    let (digits, ext) = rest.split_once('.')?;
    let rank = match ext {
        "png" => 0,
        "jpg" => 1,
        "jpeg" => 2,
        _ => return None,
    };
    if digits.len() < 5 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let index: u32 = digits.parse().ok()?;
    if index == u32::MAX {
        return None;
    }
    Some((index, rank))
}

struct OutputPaths {
    final_path: PathBuf,
    temp_path: PathBuf,
}

impl OutputPaths {
    fn prepare(out: &Path) -> Result<Self, String> {
        if out.as_os_str().is_empty() {
            return Err("No output file was given for the video".to_string());
        }
        let absolute = if out.is_absolute() {
            out.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| format!("Cannot resolve the output path {}: {}", out.display(), e))?
                .join(out)
        };
        let file_name = absolute
            .file_name()
            .ok_or_else(|| format!("The output path {} is not a file name", out.display()))?
            .to_os_string();
        let parent = absolute
            .parent()
            .ok_or_else(|| format!("The output path {} has no folder", out.display()))?;
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create the folder {}: {}", parent.display(), e))?;
        let parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        let final_path = parent.join(&file_name);
        if final_path.is_dir() {
            return Err(format!(
                "The output path {} is a folder, not a file",
                out.display()
            ));
        }
        if final_path.exists() {
            fs::OpenOptions::new()
                .write(true)
                .open(&final_path)
                .map_err(|e| {
                    format!(
                        "Cannot overwrite {} (is it open in another program?): {}",
                        out.display(),
                        e
                    )
                })?;
        }
        let mut temp_name = file_name;
        temp_name.push(".part");
        let temp_path = parent.join(temp_name);
        Ok(OutputPaths {
            final_path,
            temp_path,
        })
    }

    fn publish(&self) -> Result<(), String> {
        let started = Instant::now();
        loop {
            match fs::rename(&self.temp_path, &self.final_path) {
                Ok(()) => return Ok(()),
                Err(e) if started.elapsed() >= FILE_RETRY_LIMIT => {
                    return Err(format!(
                        "The video was encoded but could not be saved as {} (is it open in another program?): {}",
                        display_path(&self.final_path),
                        e
                    ))
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    fn discard(&self) {
        let started = Instant::now();
        while self.temp_path.exists() {
            if fs::remove_file(&self.temp_path).is_ok() || started.elapsed() >= FILE_RETRY_LIMIT {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn display_path(p: &Path) -> String {
    let s = p.display().to_string();
    match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{}", rest),
        None => s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s),
    }
}

fn wide(p: &Path) -> Vec<u16> {
    p.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

type FnStartup = unsafe extern "system" fn(u32, u32) -> HRESULT;
type FnShutdown = unsafe extern "system" fn() -> HRESULT;
type FnCreate = unsafe extern "system" fn(*mut *mut c_void) -> HRESULT;
type FnCreateAttributes = unsafe extern "system" fn(*mut *mut c_void, u32) -> HRESULT;
type FnCreateMemoryBuffer = unsafe extern "system" fn(u32, *mut *mut c_void) -> HRESULT;
type FnCreateFile = unsafe extern "system" fn(
    MF_FILE_ACCESSMODE,
    MF_FILE_OPENMODE,
    MF_FILE_FLAGS,
    PCWSTR,
    *mut *mut c_void,
) -> HRESULT;
type FnCreateSinkWriter =
    unsafe extern "system" fn(PCWSTR, *mut c_void, *mut c_void, *mut *mut c_void) -> HRESULT;

struct MfApi {
    startup: FnStartup,
    shutdown: FnShutdown,
    create_media_type: FnCreate,
    create_sample: FnCreate,
    create_attributes: FnCreateAttributes,
    create_memory_buffer: FnCreateMemoryBuffer,
    create_file: FnCreateFile,
    create_sink_writer: FnCreateSinkWriter,
}

fn media_foundation() -> Result<&'static MfApi, String> {
    static API: OnceLock<Option<MfApi>> = OnceLock::new();
    API.get_or_init(|| unsafe { MfApi::load() })
        .as_ref()
        .ok_or_else(|| ENCODER_UNAVAILABLE.to_string())
}

unsafe fn symbol(module: HMODULE, name: PCSTR) -> Option<unsafe extern "system" fn() -> isize> {
    unsafe { GetProcAddress(module, name) }
}

unsafe fn take_interface<T: Interface>(hr: HRESULT, raw: *mut c_void) -> windows::core::Result<T> {
    hr.ok()?;
    if raw.is_null() {
        return Err(E_POINTER.into());
    }
    Ok(unsafe { T::from_raw(raw) })
}

impl MfApi {
    unsafe fn load() -> Option<MfApi> {
        unsafe {
            let plat = LoadLibraryExW(w!("mfplat.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
            let readwrite =
                LoadLibraryExW(w!("mfreadwrite.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
            Some(MfApi {
                startup: std::mem::transmute::<unsafe extern "system" fn() -> isize, FnStartup>(
                    symbol(plat, s!("MFStartup"))?,
                ),
                shutdown: std::mem::transmute::<unsafe extern "system" fn() -> isize, FnShutdown>(
                    symbol(plat, s!("MFShutdown"))?,
                ),
                create_media_type: std::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    FnCreate,
                >(symbol(plat, s!("MFCreateMediaType"))?),
                create_sample: std::mem::transmute::<unsafe extern "system" fn() -> isize, FnCreate>(
                    symbol(plat, s!("MFCreateSample"))?,
                ),
                create_attributes: std::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    FnCreateAttributes,
                >(symbol(plat, s!("MFCreateAttributes"))?),
                create_memory_buffer: std::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    FnCreateMemoryBuffer,
                >(symbol(plat, s!("MFCreateMemoryBuffer"))?),
                create_file: std::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    FnCreateFile,
                >(symbol(plat, s!("MFCreateFile"))?),
                create_sink_writer: std::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    FnCreateSinkWriter,
                >(symbol(
                    readwrite,
                    s!("MFCreateSinkWriterFromURL"),
                )?),
            })
        }
    }

    unsafe fn media_type(&self) -> windows::core::Result<IMFMediaType> {
        let mut raw = std::ptr::null_mut();
        unsafe { take_interface((self.create_media_type)(&mut raw), raw) }
    }

    unsafe fn sample(&self) -> windows::core::Result<IMFSample> {
        let mut raw = std::ptr::null_mut();
        unsafe { take_interface((self.create_sample)(&mut raw), raw) }
    }

    unsafe fn attributes(&self, count: u32) -> windows::core::Result<IMFAttributes> {
        let mut raw = std::ptr::null_mut();
        unsafe { take_interface((self.create_attributes)(&mut raw, count), raw) }
    }

    unsafe fn memory_buffer(&self, len: u32) -> windows::core::Result<IMFMediaBuffer> {
        let mut raw = std::ptr::null_mut();
        unsafe { take_interface((self.create_memory_buffer)(len, &mut raw), raw) }
    }

    unsafe fn file(&self, path: &Path) -> windows::core::Result<IMFByteStream> {
        let name = wide(path);
        let mut raw = std::ptr::null_mut();
        unsafe {
            let hr = (self.create_file)(
                MF_ACCESSMODE_READWRITE,
                MF_OPENMODE_DELETE_IF_EXIST,
                MF_FILEFLAGS_NONE,
                PCWSTR(name.as_ptr()),
                &mut raw,
            );
            take_interface(hr, raw)
        }
    }

    unsafe fn sink_writer(
        &self,
        stream: &IMFByteStream,
        attributes: &IMFAttributes,
    ) -> windows::core::Result<IMFSinkWriter> {
        let mut raw = std::ptr::null_mut();
        unsafe {
            let hr = (self.create_sink_writer)(
                PCWSTR::null(),
                stream.as_raw(),
                attributes.as_raw(),
                &mut raw,
            );
            take_interface(hr, raw)
        }
    }
}

struct ComScope {
    initialized: bool,
}

impl ComScope {
    fn enter() -> Self {
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        ComScope {
            initialized: hr.is_ok(),
        }
    }
}

impl Drop for ComScope {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { CoUninitialize() };
        }
    }
}

struct MfScope {
    api: &'static MfApi,
}

impl MfScope {
    fn start(api: &'static MfApi) -> Result<Self, String> {
        let hr = unsafe { (api.startup)(MF_VERSION, MFSTARTUP_FULL) };
        if hr.is_err() {
            return Err(format!("{} ({})", ENCODER_UNAVAILABLE, hr_text(hr)));
        }
        Ok(MfScope { api })
    }
}

impl Drop for MfScope {
    fn drop(&mut self) {
        unsafe {
            let _ = (self.api.shutdown)();
        }
    }
}

struct StreamCloser(IMFByteStream);

impl Drop for StreamCloser {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.Close();
        }
    }
}

fn hr_text(hr: HRESULT) -> String {
    let message = hr.message();
    let message = message.trim();
    if message.is_empty() {
        format!("error 0x{:08X}", hr.0 as u32)
    } else {
        format!("{} [0x{:08X}]", message, hr.0 as u32)
    }
}

fn err_text(e: &windows::core::Error) -> String {
    hr_text(e.code())
}

#[derive(Clone, Copy)]
struct Geometry {
    width: u32,
    height: u32,
    enc_width: u32,
    enc_height: u32,
}

impl Geometry {
    fn new(width: u32, height: u32) -> Self {
        Geometry {
            width,
            height,
            enc_width: (width + (width & 1)).max(MIN_ENCODED_SIDE),
            enc_height: (height + (height & 1)).max(MIN_ENCODED_SIDE),
        }
    }

    fn luma_len(&self) -> usize {
        self.enc_width as usize * self.enc_height as usize
    }

    fn nv12_len(&self) -> usize {
        self.luma_len() * 3 / 2
    }

    fn macroblocks(&self) -> u64 {
        self.enc_width.div_ceil(16) as u64 * self.enc_height.div_ceil(16) as u64
    }
}

fn encode_with_media_foundation(
    frames: &[(u32, PathBuf)],
    total: u32,
    rate: FrameRate,
    paths: &OutputPaths,
    progress: &(dyn Fn(u32, u32) + Sync),
    cancel: &AtomicBool,
) -> Result<VideoReport, String> {
    let _com = ComScope::enter();
    let api = media_foundation()?;
    let _mf = MfScope::start(api)?;
    write_video(api, frames, total, rate, paths, progress, cancel)
}

fn decode_image(path: &Path) -> Result<DynamicImage, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let bytes = fs::read(path).map_err(|e| format!("{}: {}", name, e))?;
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("{}: {}", name, e))?;
    reader.decode().map_err(|e| format!("{}: {}", name, e))
}

fn image_to_nv12(image: DynamicImage, geometry: &Geometry) -> Vec<u8> {
    let image = if image.width() != geometry.width || image.height() != geometry.height {
        image.resize_exact(geometry.width, geometry.height, FilterType::Triangle)
    } else {
        image
    };
    match image {
        DynamicImage::ImageRgba8(buffer) => rgb_to_nv12(buffer.as_raw(), 4, geometry),
        DynamicImage::ImageRgb8(buffer) => rgb_to_nv12(buffer.as_raw(), 3, geometry),
        other => rgb_to_nv12(other.to_rgb8().as_raw(), 3, geometry),
    }
}

fn load_nv12(path: &Path, geometry: &Geometry) -> Result<Vec<u8>, String> {
    match catch_unwind(AssertUnwindSafe(|| {
        decode_image(path).map(|img| image_to_nv12(img, geometry))
    })) {
        Ok(result) => result,
        Err(_) => Err(format!("{}: the image decoder failed", path.display())),
    }
}

#[inline(always)]
fn luma(r: u8, g: u8, b: u8) -> u8 {
    ((Y_R * r as i32 + Y_G * g as i32 + Y_B * b as i32 + (16 << 16) + (1 << 15)) >> 16) as u8
}

#[inline(always)]
fn chroma(r: i32, g: i32, b: i32, shift: u32) -> (u8, u8) {
    let offset = (128 << shift) + (1 << (shift - 1));
    let cb = (CB_R * r + CB_G * g + CB_B * b + offset) >> shift;
    let cr = (CR_R * r + CR_G * g + CR_B * b + offset) >> shift;
    (cb.clamp(16, 240) as u8, cr.clamp(16, 240) as u8)
}

fn rgb_to_nv12(src: &[u8], bpp: usize, geometry: &Geometry) -> Vec<u8> {
    let w = geometry.width as usize;
    let h = geometry.height as usize;
    let ew = geometry.enc_width as usize;
    let stride = w * bpp;
    let mut out = vec![LUMA_BLACK; geometry.luma_len()];
    out.resize(geometry.nv12_len(), CHROMA_NEUTRAL);
    let (luma_plane, chroma_plane) = out.split_at_mut(geometry.luma_len());
    for (row, line) in luma_plane
        .chunks_exact_mut(ew)
        .zip(src.chunks_exact(stride))
        .take(h)
    {
        for (dst, px) in row[..w].iter_mut().zip(line.chunks_exact(bpp)) {
            *dst = luma(px[0], px[1], px[2]);
        }
    }
    let full_pairs = w / 2;
    for (cy, row) in chroma_plane
        .chunks_exact_mut(ew)
        .take(h.div_ceil(2))
        .enumerate()
    {
        let y0 = cy * 2;
        let top = &src[y0 * stride..(y0 + 1) * stride];
        let bottom = if y0 + 1 < h {
            Some(&src[(y0 + 1) * stride..(y0 + 2) * stride])
        } else {
            None
        };
        let (pairs, tail) = row.split_at_mut(full_pairs * 2);
        match bottom {
            Some(bottom) => {
                for ((dst, a), b) in pairs
                    .chunks_exact_mut(2)
                    .zip(top.chunks_exact(bpp * 2))
                    .zip(bottom.chunks_exact(bpp * 2))
                {
                    let r = a[0] as i32 + a[bpp] as i32 + b[0] as i32 + b[bpp] as i32;
                    let g = a[1] as i32 + a[bpp + 1] as i32 + b[1] as i32 + b[bpp + 1] as i32;
                    let bl = a[2] as i32 + a[bpp + 2] as i32 + b[2] as i32 + b[bpp + 2] as i32;
                    let (u, v) = chroma(r, g, bl, 18);
                    dst[0] = u;
                    dst[1] = v;
                }
            }
            None => {
                for (dst, a) in pairs.chunks_exact_mut(2).zip(top.chunks_exact(bpp * 2)) {
                    let r = a[0] as i32 + a[bpp] as i32;
                    let g = a[1] as i32 + a[bpp + 1] as i32;
                    let bl = a[2] as i32 + a[bpp + 2] as i32;
                    let (u, v) = chroma(r, g, bl, 17);
                    dst[0] = u;
                    dst[1] = v;
                }
            }
        }
        if w % 2 == 1 {
            let x = (w - 1) * bpp;
            let (u, v) = match bottom {
                Some(bottom) => chroma(
                    top[x] as i32 + bottom[x] as i32,
                    top[x + 1] as i32 + bottom[x + 1] as i32,
                    top[x + 2] as i32 + bottom[x + 2] as i32,
                    17,
                ),
                None => chroma(top[x] as i32, top[x + 1] as i32, top[x + 2] as i32, 16),
            };
            tail[0] = u;
            tail[1] = v;
        }
    }
    out
}

fn find_reference(
    frames: &[(u32, PathBuf)],
    cancel: &AtomicBool,
) -> Result<(usize, DynamicImage), String> {
    let mut first_error = None;
    for (k, (_, path)) in frames.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED.to_string());
        }
        match catch_unwind(AssertUnwindSafe(|| decode_image(path))) {
            Ok(Ok(image)) if image.width() > 0 && image.height() > 0 => return Ok((k, image)),
            Ok(Ok(_)) => {
                first_error
                    .get_or_insert_with(|| format!("{}: the image is empty", path.display()));
            }
            Ok(Err(e)) => {
                first_error.get_or_insert(e);
            }
            Err(_) => {
                first_error
                    .get_or_insert_with(|| format!("{}: the image decoder failed", path.display()));
            }
        }
    }
    Err(format!(
        "None of the {} frame images could be read ({})",
        frames.len(),
        first_error.unwrap_or_default()
    ))
}

struct WorkQueue {
    state: Mutex<WorkState>,
    wake: Condvar,
}

struct WorkState {
    next: usize,
    consumed: usize,
    stop: bool,
}

impl WorkQueue {
    fn lock(&self) -> MutexGuard<'_, WorkState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn mark_consumed(&self, count: usize) {
        self.lock().consumed = count;
        self.wake.notify_all();
    }

    fn stop(&self) {
        self.lock().stop = true;
        self.wake.notify_all();
    }

    fn claim(&self, jobs: usize, window: usize) -> Option<usize> {
        let mut state = self.lock();
        loop {
            if state.stop || state.next >= jobs {
                return None;
            }
            if state.next < state.consumed + window {
                let k = state.next;
                state.next += 1;
                return Some(k);
            }
            state = self.wake.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
}

struct StopOnDrop<'a>(&'a WorkQueue);

impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        self.0.stop();
    }
}

type Decoded = (usize, Result<Vec<u8>, String>);

struct Arrivals {
    rx: mpsc::Receiver<Decoded>,
    ready: HashMap<usize, Result<Vec<u8>, String>>,
}

impl Arrivals {
    fn take(&mut self, k: usize, cancel: &AtomicBool) -> Result<Result<Vec<u8>, String>, String> {
        loop {
            if let Some(result) = self.ready.remove(&k) {
                return Ok(result);
            }
            if cancel.load(Ordering::SeqCst) {
                return Err(CANCELLED.to_string());
            }
            match self.rx.recv_timeout(Duration::from_millis(25)) {
                Ok((j, result)) => {
                    self.ready.insert(j, result);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if let Some(result) = self.ready.remove(&k) {
                        return Ok(result);
                    }
                    return Err("The frame decoder stopped unexpectedly".to_string());
                }
            }
        }
    }
}

fn worker_count() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    (cores / 3).clamp(2, 6)
}

fn configure_type(
    t: &IMFMediaType,
    geometry: &Geometry,
    rate: FrameRate,
) -> windows::core::Result<()> {
    unsafe {
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        t.SetUINT64(
            &MF_MT_FRAME_SIZE,
            pack(geometry.enc_width, geometry.enc_height),
        )?;
        t.SetUINT64(&MF_MT_FRAME_RATE, rate.packed())?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
    }
    Ok(())
}

fn bitrate(geometry: &Geometry, rate: FrameRate) -> u32 {
    let bits = geometry.enc_width as f64 * geometry.enc_height as f64 * rate.as_f64() * 0.12;
    bits.clamp(2_000_000.0, 40_000_000.0).round() as u32
}

struct Encoder {
    writer: IMFSinkWriter,
    stream_index: u32,
    _stream: StreamCloser,
}

fn open_encoder(
    api: &MfApi,
    path: &Path,
    geometry: &Geometry,
    rate: FrameRate,
) -> Result<Encoder, String> {
    let shown = display_path(path);
    let stream = unsafe { api.file(path) }
        .map_err(|e| format!("Cannot create the video file {}: {}", shown, err_text(&e)))?;
    let stream = StreamCloser(stream);
    let setup_failed = |e: windows::core::Error| {
        let code = e.code();
        if code == MF_E_TOPO_CODEC_NOT_FOUND || code == REGDB_E_CLASSNOTREG {
            format!("{} ({})", ENCODER_UNAVAILABLE, err_text(&e))
        } else if geometry.macroblocks() > MAX_ENCODER_MACROBLOCKS {
            format!(
                "The frames are too large for the Windows H.264 encoder ({}x{}; it supports up to about 4096x2304 pixels)",
                geometry.width, geometry.height
            )
        } else {
            format!(
                "The Windows H.264 encoder could not be set up for {}x{} at {} fps: {}",
                geometry.enc_width,
                geometry.enc_height,
                rate.as_f64(),
                err_text(&e)
            )
        }
    };
    unsafe {
        let attributes = api.attributes(4).map_err(setup_failed)?;
        attributes
            .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 0)
            .map_err(setup_failed)?;
        attributes
            .SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 0)
            .map_err(setup_failed)?;
        attributes
            .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
            .map_err(setup_failed)?;
        let writer = api
            .sink_writer(&stream.0, &attributes)
            .map_err(setup_failed)?;

        let output = api.media_type().map_err(setup_failed)?;
        configure_type(&output, geometry, rate).map_err(setup_failed)?;
        output
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
            .map_err(setup_failed)?;
        output
            .SetUINT32(&MF_MT_AVG_BITRATE, bitrate(geometry, rate))
            .map_err(setup_failed)?;
        output
            .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
            .map_err(setup_failed)?;
        let stream_index = writer.AddStream(&output).map_err(setup_failed)?;

        let input = api.media_type().map_err(setup_failed)?;
        configure_type(&input, geometry, rate).map_err(setup_failed)?;
        input
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
            .map_err(setup_failed)?;
        input
            .SetUINT32(&MF_MT_DEFAULT_STRIDE, geometry.enc_width)
            .map_err(setup_failed)?;
        input
            .SetUINT32(&MF_MT_FIXED_SIZE_SAMPLES, 1)
            .map_err(setup_failed)?;
        input
            .SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)
            .map_err(setup_failed)?;
        input
            .SetUINT32(&MF_MT_SAMPLE_SIZE, geometry.nv12_len() as u32)
            .map_err(setup_failed)?;
        let encoding = api.attributes(1).map_err(setup_failed)?;
        encoding
            .SetUINT32(&CODECAPI_AVEncMPVDefaultBPictureCount, 0)
            .map_err(setup_failed)?;
        writer
            .SetInputMediaType(stream_index, &input, &encoding)
            .map_err(setup_failed)?;
        writer.BeginWriting().map_err(setup_failed)?;
        Ok(Encoder {
            writer,
            stream_index,
            _stream: stream,
        })
    }
}

impl Encoder {
    fn write(
        &self,
        api: &MfApi,
        data: &[u8],
        time: i64,
        duration: i64,
    ) -> windows::core::Result<()> {
        unsafe {
            let len = data.len() as u32;
            let buffer = api.memory_buffer(len)?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            if ptr.is_null() {
                let _ = buffer.Unlock();
                return Err(E_POINTER.into());
            }
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(len)?;
            let sample = api.sample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(time)?;
            sample.SetSampleDuration(duration)?;
            self.writer.WriteSample(self.stream_index, &sample)
        }
    }
}

fn write_video(
    api: &MfApi,
    frames: &[(u32, PathBuf)],
    total: u32,
    rate: FrameRate,
    paths: &OutputPaths,
    progress: &(dyn Fn(u32, u32) + Sync),
    cancel: &AtomicBool,
) -> Result<VideoReport, String> {
    let (reference, image) = find_reference(frames, cancel)?;
    let geometry = Geometry::new(image.width(), image.height());
    let first = image_to_nv12(image, &geometry);
    let encoder = open_encoder(api, &paths.temp_path, &geometry, rate)?;

    let pending = &frames[reference + 1..];
    let queue = WorkQueue {
        state: Mutex::new(WorkState {
            next: 0,
            consumed: 0,
            stop: false,
        }),
        wake: Condvar::new(),
    };
    let workers = worker_count();
    let window = workers * 2 + 2;
    let reference_index = frames[reference].0;

    let filled_gaps = std::thread::scope(|scope| -> Result<u32, String> {
        let _stop = StopOnDrop(&queue);
        let (tx, rx) = mpsc::channel::<Decoded>();
        for _ in 0..workers.min(pending.len()) {
            let tx = tx.clone();
            let queue = &queue;
            let geometry = &geometry;
            scope.spawn(move || {
                while let Some(k) = queue.claim(pending.len(), window) {
                    let result = load_nv12(&pending[k].1, geometry);
                    if tx.send((k, result)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        let mut arrivals = Arrivals {
            rx,
            ready: HashMap::new(),
        };
        let mut current = first;
        let mut next = 0usize;
        let mut gaps = 0u32;
        for i in 0..total {
            if cancel.load(Ordering::SeqCst) {
                return Err(CANCELLED.to_string());
            }
            if next < pending.len() && pending[next].0 == i {
                match arrivals.take(next, cancel)? {
                    Ok(data) => current = data,
                    Err(_) => gaps += 1,
                }
                next += 1;
                queue.mark_consumed(next);
            } else if i != reference_index {
                gaps += 1;
            }
            let time = rate.time_of(i as u64);
            let duration = rate.time_of(i as u64 + 1) - time;
            encoder.write(api, &current, time, duration).map_err(|e| {
                format!(
                    "The Windows video encoder failed at frame {} of {}: {}",
                    i,
                    total,
                    err_text(&e)
                )
            })?;
            let done = i + 1;
            if done % PROGRESS_EVERY == 0 && done < total {
                progress(done, total);
            }
        }
        Ok(gaps)
    })?;

    if cancel.load(Ordering::SeqCst) {
        return Err(CANCELLED.to_string());
    }
    unsafe { encoder.writer.Finalize() }.map_err(|e| {
        format!(
            "The Windows video encoder could not finish the video: {}",
            err_text(&e)
        )
    })?;
    drop(encoder);

    Ok(VideoReport {
        frames: total,
        filled_gaps,
        width: geometry.width,
        height: geometry.height,
        encoded_width: geometry.enc_width,
        encoded_height: geometry.enc_height,
        fps: rate.as_f64(),
        bytes: 0,
    })
}
