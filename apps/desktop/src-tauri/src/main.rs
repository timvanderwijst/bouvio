// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The same executable is the `bouvio` MCP server that agents load.
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
        if let Err(e) = rt.block_on(bouvio_runner::mcp::serve_stdio()) {
            eprintln!("bouvio mcp: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    bouvio_desktop_lib::run()
}
