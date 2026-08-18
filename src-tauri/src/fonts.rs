use std::collections::BTreeSet;
use std::sync::OnceLock;

#[tauri::command]
pub async fn available_terminal_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(cached_terminal_fonts)
        .await
        .unwrap_or_default()
}

fn cached_terminal_fonts() -> Vec<String> {
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    CACHE.get_or_init(collect_terminal_fonts).clone()
}

fn collect_terminal_fonts() -> Vec<String> {
    platform_font_families()
        .into_iter()
        .filter(|family| is_terminal_font_candidate(family))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn is_terminal_font_candidate(family: &str) -> bool {
    let normalized = family.to_lowercase();
    [
        "nerd",
        "powerline",
        "mono",
        "code",
        "menlo",
        "monaco",
        "courier",
        "consolas",
        "terminal",
        "fixed",
    ]
    .iter()
    .any(|token| normalized.contains(token))
        || platform_font_is_monospaced(family)
}

#[cfg(target_os = "macos")]
fn platform_font_families() -> Vec<String> {
    use std::ffi::{c_char, c_void, CStr};

    type CFArrayRef = *const c_void;
    type CFStringRef = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: CFArrayRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFArrayRef, index: isize) -> *const c_void;
        fn CFRelease(value: *const c_void);
        fn CFStringGetCString(
            string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
    }

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
    }

    const UTF8_ENCODING: u32 = 0x0800_0100;
    unsafe {
        let families = CTFontManagerCopyAvailableFontFamilyNames();
        if families.is_null() {
            return Vec::new();
        }
        let mut result = Vec::new();
        for index in 0..CFArrayGetCount(families) {
            let value = CFArrayGetValueAtIndex(families, index);
            if value.is_null() {
                continue;
            }
            let mut buffer = vec![0_i8; 1024];
            if CFStringGetCString(
                value,
                buffer.as_mut_ptr(),
                buffer.len() as isize,
                UTF8_ENCODING,
            ) != 0
            {
                let family = CStr::from_ptr(buffer.as_ptr())
                    .to_string_lossy()
                    .into_owned();
                if !family.is_empty() {
                    result.push(family);
                }
            }
        }
        CFRelease(families);
        result
    }
}

#[cfg(target_os = "macos")]
fn platform_font_is_monospaced(family: &str) -> bool {
    use std::ffi::{c_char, c_void, CString};
    use std::ptr;

    type CFStringRef = *const c_void;
    type CTFontRef = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: *const c_void);
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            string: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
    }

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontCreateWithName(name: CFStringRef, size: f64, matrix: *const c_void) -> CTFontRef;
        fn CTFontGetSymbolicTraits(font: CTFontRef) -> u32;
    }

    const UTF8_ENCODING: u32 = 0x0800_0100;
    const MONOSPACE_TRAIT: u32 = 1 << 10;
    let Ok(family) = CString::new(family) else {
        return false;
    };
    unsafe {
        let name = CFStringCreateWithCString(ptr::null(), family.as_ptr(), UTF8_ENCODING);
        if name.is_null() {
            return false;
        }
        let font = CTFontCreateWithName(name, 13.0, ptr::null());
        CFRelease(name);
        if font.is_null() {
            return false;
        }
        let is_monospaced = CTFontGetSymbolicTraits(font) & MONOSPACE_TRAIT != 0;
        CFRelease(font);
        is_monospaced
    }
}

#[cfg(target_os = "windows")]
fn platform_font_families() -> Vec<String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new("reg");
    command.creation_flags(CREATE_NO_WINDOW).args([
        "query",
        r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
    ]);
    let output = command.output();
    output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .map(|output| windows_font_families(&output))
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn platform_font_is_monospaced(_: &str) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn windows_font_families(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| line.split("REG_").next())
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("HKEY_"))
        .map(|name| {
            name.trim_end_matches("(TrueType)")
                .trim_end_matches("(OpenType)")
                .trim()
                .to_string()
        })
        .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_font_families() -> Vec<String> {
    Vec::new()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_font_is_monospaced(_: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_terminal_font_names() {
        assert!(is_terminal_font_candidate("JetBrains Mono"));
        assert!(is_terminal_font_candidate("MesloLGS Nerd Font"));
        assert!(!is_terminal_font_candidate("Helvetica"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn enumerates_installed_terminal_fonts_with_core_text() {
        let fonts = collect_terminal_fonts();
        assert!(!fonts.is_empty());
        assert!(fonts.iter().all(|font| is_terminal_font_candidate(font)));
    }
}
