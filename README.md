# filum

A responsive React and TypeScript planner for FluidNC string-art machines. Create nail sequences, preview toolpaths, calibrate the machine, and generate, upload, or run G-code. Planner and FluidNC logic live in DOM-free TypeScript modules; React and canvas handle the interface.

## Development

From this directory:

```sh
pnpm install
pnpm run dev
```

Use `pnpm run build` to create a production build and `pnpm run lint` to lint the project.

## Linux desktop and Android

Filum uses Tauri 2. Install Rust 1.90 or newer and the Linux system dependencies listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#linux). On Fedora, install the WebKitGTK 4.1 development package, OpenSSL development files, librsvg, and the compiler/build tools for your release.

```sh
pnpm install
pnpm run tauri:dev
pnpm run tauri:build
```

The Linux bundles are configured for `.deb`, `.rpm`, and AppImage output under `src-tauri/target/release/bundle/`. `pnpm run dev` remains the browser-only development mode.

For Android, install Android Studio and the SDK Platform, Platform-Tools, NDK (Side by side), Build-Tools, and Command-line Tools from SDK Manager. Set `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME`, then install all four Tauri Rust targets:

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
pnpm exec tauri android init
pnpm run android:dev
pnpm run android:build
```

`android:build` creates a debug APK; install the generated APK with `adb install -r <path-to-debug-apk>`. `android:dev` requires USB debugging and an authorized device.

Tauri's generated icon is a placeholder; replace it with Filum artwork and regenerate platform icons with `pnpm exec tauri icon <image-file>`.

### Device access and network status

The packaged app uses the Rust-backed Tauri WebSocket and HTTP plugins; browser development uses the WebView's native APIs. FluidNC's existing endpoint fallback order and `webui-v3` subprotocol are retained. The HTTP plugin is scoped to private IPv4 networks and localhost. Tauri's WebSocket plugin does not expose a URL-scope permission, so the app only constructs its existing FluidNC port/path attempts from the configured board address. No Android cleartext manifest override is enabled.

**The packaged network spike has not yet been run against a FluidNC board.** Browser-mode UI was exercised, but the WebView and Rust transports have not been compared from a packaged Tauri app. This environment does not have the Linux WebKitGTK 4.1 dependency or an attached Android device. Therefore Rust-backed WebSocket/HTTP compatibility, multipart upload, SD listing, and actual Linux/Android packaged builds remain unverified. Open `/spike` in the packaged app (or use `?spike=1`) to test the WebView transport followed by the Rust transport. It uploads a uniquely named, text-only file and leaves it on the board SD card. Confirm the Rust transport with `pnpm run tauri:dev` and `pnpm run android:dev` on the board's network before relying on it; if it fails, capture the app logs and test the WebView transport before changing Android cleartext settings.

On this machine, `tauri android init` also stops because Android SDK Command-line Tools and the NDK are missing; `JAVA_HOME` and Android Rust targets are not configured. Consequently, no generated Android project or INTERNET-manifest check is included yet. The Screen Wake Lock API is wired and logs failures, but Android WebView support and a Kotlin window-flag fallback still need phone verification.

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
