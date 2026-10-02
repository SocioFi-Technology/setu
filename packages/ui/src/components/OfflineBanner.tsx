import { Icon } from "./Icon";
export function OfflineBanner({ text, queued }: { text: string; queued: string }) {
  return (
    <div role="status" className="offline-banner">
      <Icon name="wifi-off" size={16} /><span style={{ flex: 1 }}>{text}</span><b className="num">{queued}</b>
    </div>
  );
}
