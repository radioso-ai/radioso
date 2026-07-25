export const metadata = {
  // `absolute` opts out of the root brand template — an embedded iframe should
  // not carry the Radioso suffix inside the host site.
  title: { absolute: "Embedded Chat" },
  description: "Embedded chat with our AI assistant",
};

export default function EmbeddedChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex h-screen overflow-hidden">{children}</div>;
}
