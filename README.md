# filum

A responsive React and TypeScript planner for FluidNC string-art machines. Create nail sequences, preview toolpaths, calibrate the machine, and generate, upload, or run G-code. Planner and FluidNC logic live in DOM-free TypeScript modules; React and canvas handle the interface.

## Development

From this directory:

```sh
pnpm install
pnpm run dev
```

Use `pnpm run build` to create a production build and `pnpm run lint` to lint the project.

## Desktop and Android builds

Filum uses Tauri 2. Install Rust 1.90 or newer and the Linux dependencies listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

### Fedora desktop

Install the Fedora development packages and RPM bundler dependency:

```sh
sudo dnf install webkit2gtk4.1-devel openssl-devel librsvg2-devel libappindicator-gtk3-devel gcc gcc-c++ make rpm-build
```

From this directory, build and install the Fedora RPM:

```sh
pnpm install
pnpm run tauri:dev
pnpm exec tauri build --bundles rpm
sudo dnf install ./src-tauri/target/release/bundle/rpm/*.rpm
```

The configured Linux bundle formats are `.deb`, `.rpm`, and AppImage, under `src-tauri/target/release/bundle/`. Run `pnpm run tauri:build` to build all configured formats. Tauri does not produce a Flatpak; this repository currently has no Flatpak manifest or Flatpak build instructions. `pnpm run dev` starts browser-only mode.

### Android

Install Android Studio. In **Tools → SDK Manager**, install Android SDK Platform **37** (the current Gradle project uses compile/target SDK 37), Platform-Tools, NDK (Side by side), Build-Tools, and Command-line Tools (latest). Set `JAVA_HOME` to Android Studio's bundled JBR directory. Then, from this directory, configure the SDK environment. The NDK command selects the highest installed side-by-side version, so it does not require typing a placeholder version:

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

Initialize the Android project once, then build a debug APK:

```sh
pnpm exec tauri android init
pnpm run android:build
find src-tauri/gen/android/app/build/outputs -name '*.apk' -print
```

Install the APK with `adb install -r <apk-path>`. For live development on a connected device with USB debugging enabled, run `pnpm run android:dev`.

### What to commit

Commit `src-tauri/`: its Rust sources, Cargo files, capabilities, icons, and Tauri configuration are required to build the app. After `tauri android init`, commit `src-tauri/gen/android/` too; it contains the Gradle wrapper and Android project configuration. The existing ignore rules exclude Cargo build output, generated schemas, Gradle/build caches, local SDK settings, and signing keys. Do not add a blanket `src-tauri/**` ignore.

Tauri's generated icon is a placeholder; replace it with Filum artwork and regenerate platform icons with `pnpm exec tauri icon <image-file>`.

### Device access and network status

The packaged app uses the Rust-backed Tauri WebSocket and HTTP plugins; browser development uses the WebView's native APIs. FluidNC's existing endpoint fallback order and `webui-v3` subprotocol are retained. Tauri's HTTP plugin scope permits only the `/upload` path over HTTP; `boardURL` validates that upload targets are private IPv4 addresses or localhost before sending. Tauri's WebSocket plugin does not expose a URL-scope permission, so the app only constructs its existing FluidNC port/path attempts from the configured board address. The generated Android debug variant permits cleartext traffic for local FluidNC HTTP; review the Android network policy before distributing a release build.

To test board connectivity, open `/spike` in a Tauri or Android build (or use `?spike=1`). It compares the WebView and Rust-backed transports, uploads small uniquely named text files, and leaves them on the board SD card. Verify the Rust transport and SD listing on the same network before running a real job.

### Files, persistence, and mobile behavior

Calibration measurements, the board address, and appearance preference are persisted through the Tauri store in native builds, with migration from matching browser `localStorage` keys on first launch. Browser mode continues to use `localStorage`. Keep using the calibration Export/Import JSON controls as a portable backup.

Sequence and calibration imports use native file pickers in Tauri. G-code and calibration exports use Save dialogs; if Android's save dialog fails, Filum writes the file in its app data directory and reports that path (app data may not be directly visible in a file manager). Android file access is restricted by Tauri to app-accessible locations unless additional storage permissions are configured.

Machine confirmations are in-app and require an explicit choice. Tauri uploads use the Rust HTTP plugin and preserve FluidNC's multipart fields. Upload verification first matches the response `files` entry by name and byte size; if the response is unavailable or unreadable, Filum falls back to checking `$SD/List`. The request timeout is ten minutes. The progress bar remains animated. Screen wake lock is requested while Filum is performing an active machine action or streamed run. On return to the foreground, a disconnected controller is reconnected and the existing status-based progress tracker can reattach to an SD-card job.

### Renaming Filum

Change `productName`, the desktop window title, and `identifier` in `src-tauri/tauri.conf.json`; update the `filum` brand in `index.html` and the app UI if the visible name should also change. Keep the Tauri version synchronized with `package.json`. Android's generated package identifier is created by `tauri android init`, so regenerate or update the Android project after changing the identifier.

### Android release signing

Signing credentials are not included. Generate your own keystore locally; do not commit it or `src-tauri/keystore.properties`:

```sh
keytool -genkeypair -v -keystore filum-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias filum
```

## Interface

The desktop sidebar provides FluidNC connection, calibration, and motion controls. The top bar has **File**, **Settings**, and **Machine** popup menus; open **Settings → Planner settings** to configure planner values and choose a **Light**, **Dark**, or **System** appearance. Your choice is saved in this browser. On mobile, use the hamburger menu.
