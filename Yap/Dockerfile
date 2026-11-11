# Exact patch tags, not the floating 10.0: the runtime carries the fix for CVE-2026-111497 (an out-of-bounds
# write in the Brotli decoder, fixed in 10.0.14 on 2026-10-25). A floating tag resolves to whatever image the
# Docker host has cached, so a rebuild can keep an old runtime with no change in this file. Bump both tags
# together on each .NET 10 patch release (the SDK tag below ships the same runtime).
FROM mcr.microsoft.com/dotnet/aspnet:10.0.14 AS base
# ffmpeg/ffprobe are pinned static builds, not distro packages: the GIF preview pipeline decodes
# animated WebP, which needs ffmpeg >= 9.0 — no 6.x/7.x/8.x release has the decoder, so no distro
# repo qualifies (noble ships 6.1, resolute 8.0; verified against real library files 2026-08-08).
# yt-dlp and every other media path use these same binaries via PATH.
COPY --from=mwader/static-ffmpeg:9.0 /ffmpeg /ffprobe /usr/local/bin/
# yt-dlp_linux (PyInstaller build), NOT the plain zipimport binary: only the standalone
# build bundles curl_cffi, which the TikTok extractor needs to impersonate a browser.
# Without it TikTok answers server IPs with a challenge page and extraction fails
# (verified on live 2026-09-02). The standalone build also removes the python3 dependency.
#
# ADD, not `apt-get install curl && curl -L ...`: BuildKit downloads the file itself, so the build does
# not need Ubuntu's package servers and the image carries no curl. On 2026-11-11 the GitHub runner could
# not resolve archive.ubuntu.com for more than 30 minutes, and four builds in a row failed at apt, for a
# tool whose only job was to fetch this one file. Nothing in the image calls curl at run time.
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /usr/local/bin/yt-dlp
# Deno is yt-dlp's JavaScript runtime for YouTube. Recent yt-dlp releases have the YouTube extractor
# solve the player challenge in JS, which needs a runtime on PATH; without one the metadata probe
# exits 1 with "No supported JavaScript runtime could be found" and every YouTube link silently
# gets no embed (seen on live 2026-09-06). Deno is the only runtime yt-dlp enables by default.
# Pinned bare binary from the official image, same pattern as ffmpeg above.
COPY --from=denoland/deno:bin-2.9.6 /deno /usr/local/bin/deno
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:10.0.403 AS build
WORKDIR /src
COPY ["Yap.csproj", "."]
RUN dotnet restore
COPY . .
RUN dotnet build -c Release -o /app/build

FROM build AS publish
RUN dotnet publish -c Release -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
# Keep a copy of default config for first-run
COPY --from=publish /app/publish/appsettings.json ./appsettings.default.json
# Copy and set up entrypoint
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh
ENTRYPOINT ["./docker-entrypoint.sh"]
