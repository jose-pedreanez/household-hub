import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Household Hub",
    short_name: "Hub",
    description: "Groceries, inventory, meals and shopping for our household.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f8f6f2",
    theme_color: "#2f6f4f",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Scan groceries", url: "/scan", short_name: "Scan" },
      { name: "Shopping list", url: "/shopping", short_name: "Shopping" },
    ],
  };
}
