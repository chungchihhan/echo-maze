import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Echo Maze — Observable AI Navigation Benchmark",
  description: "Watch AI agents navigate hidden mazes using local observations and conversation-only memory.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
