export const metadata = {
  title: "Embedded Chat",
  description: "Embedded chat with our AI assistant",
};

export default function EmbeddedChatFrameLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex h-screen overflow-hidden">{children}</div>;
}
