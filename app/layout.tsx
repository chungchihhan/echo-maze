import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Echo Maze — One Agent, Hidden Maze",
  description: "An AI Walker navigating a hidden maze through observation, memory, and self-maintained coordinates.",
  icons: {
    icon: "/echo-maze-icon.png",
    shortcut: "/echo-maze-icon.png",
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
