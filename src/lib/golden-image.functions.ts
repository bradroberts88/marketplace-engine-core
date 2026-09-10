import { createServerFn } from "@tanstack/react-start";

const OWNER = "bradroberts88";
const REPO = "marketplace-engine-core";
const TAG = "autpost-golden";

/** Fallback hashes published with the release, used if GitHub omits asset digests. */
const KNOWN_DIGESTS: Record<string, string> = {
  "autopost-golden.img.xz":
    "430df52d46965a1ec501ccdd2d21666fe0ae410fd2d8e14f45f75cf3ccb520ac",
  "autopost-golden-zerow.img.xz":
    "618c6c8a3fa0d4ad5ca3be23e02efb2821fdfeba645038f9c5c393caa8d9c9be",
};

const TARGETS: Record<string, string> = {
  "autopost-golden.img.xz": "Pi 4 class · arm64 (64-bit)",
  "autopost-golden-zerow.img.xz": "Pi Zero W / Pi 1 · armhf (boots on every Pi)",
};

export type GoldenAsset = {
  name: string;
  target: string;
  sizeBytes: number;
  downloadUrl: string;
  sha256: string | null;
  downloadCount: number;
  updatedAt: string;
};

export type GoldenBuild = {
  status: "published" | "unavailable";
  tag: string;
  name: string;
  publishedAt: string | null;
  releaseUrl: string;
  assets: GoldenAsset[];
  fetchedAt: string;
  error: string | null;
};

type GitHubAsset = {
  name: string;
  size: number;
  browser_download_url: string;
  download_count: number;
  updated_at: string;
  digest?: string | null;
};

type GitHubRelease = {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  html_url: string;
  draft: boolean;
  assets: GitHubAsset[];
};

const releaseUrl = `https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`;

function emptyBuild(error: string): GoldenBuild {
  return {
    status: "unavailable",
    tag: TAG,
    name: TAG,
    publishedAt: null,
    releaseUrl,
    assets: [],
    fetchedAt: new Date().toISOString(),
    error,
  };
}

export const getGoldenBuild = createServerFn({ method: "GET" }).handler(
  async (): Promise<GoldenBuild> => {
    const token = process.env["GITHUB_TOKEN"];
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "marketplace-engine-dashboard",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
      const res = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`,
        { headers },
      );

      if (!res.ok) {
        return emptyBuild(
          res.status === 404
            ? "Release not found — it may be a draft, which is only visible when signed in on GitHub."
            : `GitHub returned ${res.status}. Showing no live data.`,
        );
      }

      const release = (await res.json()) as GitHubRelease;

      const assets: GoldenAsset[] = release.assets
        .map((asset) => {
          const digest = asset.digest?.replace(/^sha256:/, "") ?? null;
          return {
            name: asset.name,
            target: TARGETS[asset.name] ?? "Raspberry Pi appliance",
            sizeBytes: asset.size,
            downloadUrl: asset.browser_download_url,
            sha256: digest ?? KNOWN_DIGESTS[asset.name] ?? null,
            downloadCount: asset.download_count,
            updatedAt: asset.updated_at,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        status: "published",
        tag: release.tag_name,
        name: release.name ?? release.tag_name,
        publishedAt: release.published_at,
        releaseUrl: release.html_url,
        assets,
        fetchedAt: new Date().toISOString(),
        error: null,
      };
    } catch {
      return emptyBuild("Could not reach GitHub. Showing no live data.");
    }
  },
);
