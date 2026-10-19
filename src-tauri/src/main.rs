// HAVEWA-07C — Windows-Entry-Point.
// Auf Windows ist `fn main()` der Tauri-Entry; lib::run() enthält die
// Orchestrierung und ist damit von Mobile-Tests/CI ohne Binary-Init
// aufrufbar (siehe lib.rs).

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    havewa_desktop::run();
}