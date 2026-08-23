import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Echo Maze — Observable Agent Cooperation",
  description: "An AI Walker navigating a hidden maze through observation, memory, and self-maintained coordinates.",
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
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
