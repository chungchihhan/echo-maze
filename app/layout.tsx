import type { Metadata } from "next";
import { StarPrompt } from "./star-prompt";
import "./globals.css";

export const metadata: Metadata = {
  title: "Echo Maze — Memory in Motion",
  description: "The EMZ Benchmark evaluates AI agents navigating a hidden maze through observation, memory, and self-maintained coordinates.",
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
      <body>{children}<StarPrompt /></body>
    </html>
  );
}
