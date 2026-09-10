import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  HardDrive,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getGoldenBuild, type GoldenAsset } from "@/lib/golden-image.functions";
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format";

const goldenBuildQuery = queryOptions({
  queryKey: ["golden-build"],
  queryFn: () => getGoldenBuild(),
  staleTime: 5 * 60 * 1000,
});

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(goldenBuildQuery),
  component: GoldenImageDashboard,
  head: () => ({
    meta: [
      { title: "Marketplace Engine — Golden image build status" },
      {
        name: "description",
        content:
          "Live status, SHA256 checksums and download links for the AutoPost golden Raspberry Pi images shipped to dealerships.",
      },
      { property: "og:title", content: "Marketplace Engine — Golden image build status" },
      {
        property: "og:description",
        content:
          "Live status, SHA256 checksums and download links for the AutoPost golden Raspberry Pi images.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        });
      }}
    >
      {copied ? <CheckCircle2 className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

function AssetCard({ asset }: { asset: GoldenAsset }) {
  return (
    <Card className="border-border/70 bg-card">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="font-mono text-base break-all">{asset.name}</CardTitle>
            <CardDescription className="flex items-center gap-1.5">
              <Cpu className="size-3.5" />
              {asset.target}
            </CardDescription>
          </div>
          <Badge variant="outline" className="border-primary/40 text-primary">
            {formatBytes(asset.sizeBytes)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 rounded-md bg-panel/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs tracking-wide text-muted-foreground uppercase">SHA256</span>
            {asset.sha256 ? <CopyButton value={asset.sha256} label="Copy hash" /> : null}
          </div>
          <p className="font-mono text-xs leading-relaxed break-all text-foreground/90">
            {asset.sha256 ?? "Not published for this asset"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>Updated {formatDateTime(asset.updatedAt)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatNumber(asset.downloadCount)} downloads</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" className="gap-2">
            <a href={asset.downloadUrl} rel="noopener noreferrer">
              <Download className="size-4" />
              Download image
            </a>
          </Button>
          <CopyButton value={asset.downloadUrl} label="Copy link" />
        </div>
      </CardContent>
    </Card>
  );
}

function GoldenImageDashboard() {
  const { data, refetch, isFetching } = useSuspenseQuery(goldenBuildQuery);
  const published = data.status === "published";

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-5xl px-6 py-12">
        <header className="space-y-4">
          <Badge variant="outline" className="border-primary/40 text-primary">
            Marketplace Engine
          </Badge>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Golden image build status
          </h1>
          <p className="max-w-2xl text-muted-foreground">
            The Raspberry Pi appliance images that dealerships are flashed with, straight from the
            published release. Verify every card against these checksums before it ships.
          </p>
        </header>

        <Separator className="my-8" />

        <Card className="border-border/70 bg-card">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1.5">
                <CardTitle className="flex items-center gap-2">
                  <HardDrive className="size-5 text-primary" />
                  Release {data.tag}
                </CardTitle>
                <CardDescription>
                  {published
                    ? `Published ${formatDateTime(data.publishedAt)} · checked ${formatDateTime(data.fetchedAt)}`
                    : "No live release data available right now."}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {published ? (
                  <Badge className="gap-1.5 bg-success text-success-foreground">
                    <CheckCircle2 className="size-3.5" />
                    Published
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="gap-1.5">
                    <ShieldAlert className="size-3.5" />
                    Unavailable
                  </Badge>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={isFetching}
                  onClick={() => void refetch()}
                >
                  <RefreshCw className={isFetching ? "size-4 animate-spin" : "size-4"} />
                  Refresh
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.error ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
                {data.error}
              </p>
            ) : null}
            <Button asChild variant="outline" size="sm" className="gap-2">
              <a href={data.releaseUrl} target="_blank" rel="noopener noreferrer">
                Open the release on GitHub
                <ArrowUpRight className="size-4" />
              </a>
            </Button>
          </CardContent>
        </Card>

        <section className="mt-8 space-y-4">
          <h2 className="text-lg font-medium">Images in this release</h2>
          {data.assets.length === 0 ? (
            <Card className="border-dashed border-border/70 bg-card">
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No images are attached to this release yet.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {data.assets.map((asset) => (
                <AssetCard key={asset.name} asset={asset} />
              ))}
            </div>
          )}
        </section>

        <section className="mt-10">
          <Card className="border-border/70 bg-card">
            <CardHeader>
              <CardTitle className="text-base">Verify a downloaded image</CardTitle>
              <CardDescription>
                Run this on the bench PC and compare the result with the hash above before flashing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <pre className="overflow-x-auto rounded-md bg-panel/60 p-3 font-mono text-xs text-foreground/90">
                <code>{`# Windows PowerShell
Get-FileHash .\\autopost-golden.img.xz -Algorithm SHA256

# Linux / WSL
sha256sum autopost-golden.img.xz`}</code>
              </pre>
              <p className="text-xs text-muted-foreground">
                A mismatch means the download is damaged or tampered with — delete it and download
                again. Never flash an image whose hash does not match.
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}
