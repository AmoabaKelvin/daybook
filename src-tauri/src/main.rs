// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The same binary is the `daybook` command: with a subcommand it runs that and exits.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = daybook_lib::cli::run(&args) {
        std::process::exit(code);
    }
    daybook_lib::run();
}
