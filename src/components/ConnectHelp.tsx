import { useState } from 'react'
import { Copy, Check, Gamepad2, Loader2, TerminalSquare } from 'lucide-react'
import { useStore } from '../store'
import { useApp } from '../appStore'
import { Button } from './ui'

function CopyChip({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setDone(true)
      setTimeout(() => setDone(false), 1400)
    } catch {
      setDone(false)
    }
  }
  return (
    <button className="copy-chip" onClick={copy} title="Copy">
      <code>{text}</code>
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

export function ConnectHelp() {
  const conn = useStore((s) => s.conn)
  const discovery = useApp((s) => s.discovery)
  const setView = useApp((s) => s.setView)
  const busy = conn === 'connecting' || conn === 'authenticating'

  if (busy) {
    return (
      <div className="connect-help">
        <Loader2 className="spin" size={28} />
        <h2>Connecting to {discovery?.endpoint?.project_name ?? 'the game'}…</h2>
      </div>
    )
  }

  const status = discovery?.status
  const editor = !!discovery?.editor_running

  return (
    <div className="connect-help">
      <div className="connect-icon"><Gamepad2 size={30} strokeWidth={1.6} /></div>
      {status === 'no_token' ? (
        <>
          <h2>Found the game, waiting for its control server</h2>
          <p>
            {discovery?.endpoint?.process_name ?? 'The game'} is running, but its access key isn’t in its log yet.
            This usually clears within a few seconds after the server starts.
          </p>
          {discovery?.detail ? <p className="connect-detail">{discovery.detail}</p> : null}
          <Button variant="ghost" onClick={() => setView('settings')}>Connect manually instead</Button>
        </>
      ) : (
        <>
          <h2>{editor ? 'Unreal Editor is open — start the game' : 'Start your game to begin'}</h2>
          <ol className="connect-steps">
            {editor ? (
              <li>Press <b>Play</b> in the editor. A new window works best.</li>
            ) : (
              <li>Launch the game build.</li>
            )}
            <li>
              Open the game console with the <kbd>~</kbd> key and run
              <CopyChip text="IAI.Server.Start" />
            </li>
            <li>This window connects on its own. There’s nothing to type here.</li>
          </ol>
          <div className="connect-tip">
            <TerminalSquare size={16} />
            <span>
              Skip step 2 next time: add <CopyChip text={'-ExecCmds="IAI.Server.Start"'} /> to the game’s launch command.
            </span>
          </div>
        </>
      )}
    </div>
  )
}
