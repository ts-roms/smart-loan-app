/**
 * GENERATED — dynamic-import map for the barangay chunks.
 *
 * Written as an explicit literal rather than a template path so the
 * bundler can see every chunk and split them; `import(`./${id}`)`
 * would either fail to resolve or pull all seventeen into one.
 */
export const BARANGAY_CHUNKS: Record<
  string,
  () => Promise<{ BARANGAYS: Record<string, string[]> }>
> = {
  "0100000000": () => import("./01"),
  "0200000000": () => import("./02"),
  "0300000000": () => import("./03"),
  "0400000000": () => import("./04"),
  "1700000000": () => import("./17"),
  "0500000000": () => import("./05"),
  "0600000000": () => import("./06"),
  "0700000000": () => import("./07"),
  "0800000000": () => import("./08"),
  "0900000000": () => import("./09"),
  "1000000000": () => import("./10"),
  "1100000000": () => import("./11"),
  "1200000000": () => import("./12"),
  "1600000000": () => import("./16"),
  "1300000000": () => import("./13"),
  "1400000000": () => import("./14"),
  "1900000000": () => import("./19"),
};
