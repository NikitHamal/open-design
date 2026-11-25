// OpenDesign desktop shell: starts the bundled Node daemon (which serves the UI and the
// Zeus provider engine), then points a WebView2 window at it. Nothing leaves the machine
// except the requests the user's chosen providers make.

use std::{
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const PREFERRED_PORT: u16 = 17456;
const BROWSER_ARGS: &str = "--renderer-process-limit=1 --process-per-site --disable-site-isolation-trials \
--disable-features=IsolateOrigins,site-per-process,SpareRendererForSitePerProcess,msWebOOUI,msPdfOOUI,msSmartScreenProtection,Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,BackForwardCache,Prerender2,AutofillServerCommunication,CertificateTransparencyComponentUpdater \
--disable-extensions --disable-component-update --disable-background-networking --disable-sync --no-first-run --no-default-browser-check --no-pings";

const LINK_GUARD: &str = r#"
(() => {
  const external = (u) => /^https?:/i.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost|tauri\.localhost)(:|\/|$)/i.test(u);
  const nativeOpen = window.open;
  window.open = function (u, t, f) {
    try {
      const abs = new URL(String(u || ''), location.href).href;
      if (external(abs)) { location.assign(abs); return null; }
    } catch (_) {}
    return nativeOpen.call(window, u, t, f);
  };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]');
    if (!a || !a.href || !external(a.href)) return;
    e.preventDefault();
    location.assign(a.href);
  }, true);
})();
"#;

#[derive(Default)]
struct DaemonState {
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
}

fn clean(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

fn pick_port() -> u16 {
    if TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).is_ok() {
        return PREFERRED_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(PREFERRED_PORT + 1)
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_daemon(res: &Path, data: &Path, port: u16) -> std::io::Result<Child> {
    let node = res.join("node").join(if cfg!(windows) { "node.exe" } else { "node" });
    let cli = res.join("app").join("apps").join("daemon").join("dist").join("cli.mjs");
    let mut cmd = Command::new(&node);
    cmd.arg(&cli)
        .args(["--no-open", "--port", &port.to_string()])
        .current_dir(res.join("app"))
        .env("OD_PORT", port.to_string())
        .env("OD_DATA_DIR", data)
        .env("OD_DAEMON_CLI_PATH", &cli)
        .env("OD_NODE_BIN", &node)
        .env("OD_NO_TELEMETRY", "1")
        .env("NODE_ENV", "production")
        .env("NODE_OPTIONS", "--max-old-space-size=384")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn()
}

fn wait_ready(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(120));
    }
    false
}

fn open_external(url: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}

fn supervise(app: AppHandle, res: PathBuf, data: PathBuf, port: u16) {
    let state = app.state::<Arc<DaemonState>>().inner().clone();
    let mut restarts = 0u32;
    loop {
        if state.stopping.load(Ordering::SeqCst) {
            return;
        }
        let exited = {
            let mut guard = state.child.lock().unwrap();
            match guard.as_mut() {
                Some(c) => c.try_wait().ok().flatten(),
                None => return,
            }
        };
        if let Some(status) = exited {
            if state.stopping.load(Ordering::SeqCst) {
                return;
            }
            if status.success() || restarts >= 5 {
                app.exit(0);
                return;
            }
            restarts += 1;
            match spawn_daemon(&res, &data, port) {
                Ok(c) => *state.child.lock().unwrap() = Some(c),
                Err(_) => {
                    app.exit(1);
                    return;
                }
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
}

pub fn run() {
    let state = Arc::new(DaemonState::default());
    let exit_state = state.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(state.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let res = clean(handle.path().resource_dir()?);
            let data = clean(handle.path().app_data_dir()?).join("data");
            let _ = std::fs::create_dir_all(&data);
            let port = pick_port();

            let window = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                .title("OpenDesign")
                .inner_size(1360.0, 860.0)
                .min_inner_size(960.0, 640.0)
                .maximized(true)
                .center()
                .background_color(tauri::window::Color(20, 18, 24, 255))
                .additional_browser_args(BROWSER_ARGS)
                .initialization_script(LINK_GUARD)
                .on_navigation(|url| match url.scheme() {
                    "http" | "https" => {
                        let local = matches!(url.host_str(), Some("127.0.0.1") | Some("localhost") | Some("tauri.localhost"));
                        if !local {
                            open_external(url.as_str());
                        }
                        local
                    }
                    _ => true,
                })
                .build()?;

            let child = spawn_daemon(&res, &data, port)?;
            *state.child.lock().unwrap() = Some(child);

            let h2 = handle.clone();
            thread::spawn(move || {
                if wait_ready(port, Duration::from_secs(90)) {
                    let _ = window.eval(&format!("window.location.replace('http://127.0.0.1:{port}/')"));
                } else {
                    let _ = window.eval("document.body.style.background='#601410'");
                }
                supervise(h2, res, data, port);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build OpenDesign");

    app.run(move |_handle, event| {
        if let RunEvent::Exit = event {
            exit_state.stopping.store(true, Ordering::SeqCst);
            if let Some(mut c) = exit_state.child.lock().unwrap().take() {
                kill_tree(&mut c);
            }
        }
    });
}
