import type { MetadataRoute } from "next";

/** Installable app (home screen / desktop) with the blue Platinum "P". Icons live under /brand/ (see deploy/proxy/user.conf). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Platinum AIT",
    short_name: "Platinum AIT",
    description: "Agent in Training dashboard for Platinum Insurance Group",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0b6e99",
    icons: [
      { src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/app-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
