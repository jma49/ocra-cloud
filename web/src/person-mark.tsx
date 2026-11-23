// Who a line is about, at a glance: their picture where the platform gave
// one the console may load, their initial otherwise.

export function PersonMark(props: { login: string; avatar?: string | null; size?: number }) {
  const size = props.size ?? 20;
  if (props.avatar)
    return <img className="person-mark" src={props.avatar} alt="" width={size} height={size} />;
  return (
    <span className="person-mark" aria-hidden="true" style={{ width: size, height: size }}>
      {props.login.replace(/^@/, "").slice(0, 1).toUpperCase()}
    </span>
  );
}
