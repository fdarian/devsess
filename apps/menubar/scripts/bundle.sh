#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
swift build -c release
mkdir -p build/Devsess.app/Contents/MacOS
cp .build/release/Devsess build/Devsess.app/Contents/MacOS/Devsess
cat >build/Devsess.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.fdarian.devsess.menubar</string>
<key>CFBundleName</key><string>Devsess</string>
<key>CFBundleExecutable</key><string>Devsess</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict></plist>
PLIST
codesign -s - --force build/Devsess.app
