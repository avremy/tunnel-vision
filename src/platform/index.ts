import { mac } from "./mac";
import type { Platform } from "./types";
import { win } from "./win";

export * from "./types";
export const platform: Platform = process.platform === "win32" ? win : mac;
