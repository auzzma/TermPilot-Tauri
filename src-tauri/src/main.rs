#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if termpilot_lib::run_askpass() {
        return;
    }
    termpilot_lib::run();
}
