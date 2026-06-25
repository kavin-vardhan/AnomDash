export const PROTOCOL_VERSION = 1

const MAGIC = [0x41, 0x49, 0x46, 0x31]

export interface FrameHeader {
  frameId: number
  epoch: number
  w: number
  h: number
}

export function isFrameBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 16 && MAGIC.every((m, i) => bytes[i] === m)
}

export function parseFrameHeader(bytes: Uint8Array): FrameHeader {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    frameId: dv.getUint32(4, true),
    epoch: dv.getUint32(8, true),
    w: dv.getUint16(12, true),
    h: dv.getUint16(14, true),
  }
}

export function frameJpegSlice(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(16)
}
