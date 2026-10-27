//! Start at sign-in: the Windows Run key or an opt-in macOS LaunchAgent.

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "EzooDownload";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn reg(args: &[&str]) -> bool {
        Command::new(swiftget_engine::system::windows_tool("reg.exe"))
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub fn is_enabled() -> bool {
        reg(&["query", KEY, "/v", NAME])
    }

    /// Installed with the setup program (which asked about autostart itself).
    pub fn installed_by_setup() -> bool {
        reg(&["query", r"HKCU\Software\Ezoo\EzooDownload", "/v", "Installed"])
    }

    pub fn refresh_legacy_path() {}

    pub fn set(enabled: bool) -> bool {
        if enabled {
            let Ok(exe) = std::env::current_exe() else { return false };
            let value = format!("\"{}\" --background", exe.display());
            reg(&["add", KEY, "/v", NAME, "/t", "REG_SZ", "/d", &value, "/f"])
        } else {
            !is_enabled() || reg(&["delete", KEY, "/v", NAME, "/f"])
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::{Path, PathBuf};

    const LABEL: &str = "com.ezoo.EzooDownload";

    fn agent_path() -> Option<PathBuf> {
        Some(PathBuf::from(std::env::var_os("HOME")?).join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
    }

    fn plist(executable: &Path) -> String {
        managed_plist(executable, true)
    }

    // Keep the previous exact rendering for migration, so an existing opt-in
    // can become quiet at sign-in without taking ownership of custom agents.
    fn managed_plist(executable: &Path, background: bool) -> String {
        let escaped = executable.to_string_lossy()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('\"', "&quot;")
            .replace('\'', "&apos;");
        let background_arg = if background { "<string>--background</string>" } else { "" };
        format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{LABEL}</string>
<key>ProgramArguments</key><array><string>{escaped}</string>{background_arg}</array>
<key>RunAtLoad</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
"#)
    }

    pub fn is_enabled() -> bool {
        agent_path().is_some_and(|path| path.is_file())
    }

    pub fn installed_by_setup() -> bool {
        false
    }

    // Only replace exact managed plists at the current or old sibling path.
    // Never create a LaunchAgent or overwrite a user-customized one.
    fn refresh_at(path: &Path, executable: &Path) -> bool {
        let Some(macos) = executable.parent() else { return false };
        let Some(contents) = macos.parent() else { return false };
        let Some(bundle) = contents.parent() else { return false };
        if executable.file_name().and_then(|s| s.to_str()) != Some("MacDownloader")
            || macos.file_name().and_then(|s| s.to_str()) != Some("MacOS")
            || contents.file_name().and_then(|s| s.to_str()) != Some("Contents")
            || bundle.file_name().and_then(|s| s.to_str()) != Some("Mac Downloader.app") {
            return false;
        }
        let Some(app_dir) = bundle.parent() else { return false };
        let old_executable = app_dir.join("Ezoo Download.app/Contents/MacOS/EzooDownload");
        let Ok(current) = std::fs::read_to_string(path) else { return false };
        let replacement = plist(executable);
        if current == replacement {
            return false;
        }
        let managed = current == managed_plist(executable, false)
            || current == managed_plist(&old_executable, false)
            || current == managed_plist(&old_executable, true);
        if !managed {
            return false;
        }
        let staged = path.with_extension(format!("{}.tmp", std::process::id()));
        let result = std::fs::write(&staged, replacement).and_then(|_| std::fs::rename(&staged, path));
        if result.is_err() { let _ = std::fs::remove_file(staged); }
        result.is_ok()
    }

    pub fn refresh_legacy_path() {
        if let (Some(path), Ok(executable)) = (agent_path(), std::env::current_exe()) {
            let _ = refresh_at(&path, &executable);
        }
    }

    pub fn set(enabled: bool) -> bool {
        let Some(path) = agent_path() else { return false };
        if !enabled {
            return !path.exists() || std::fs::remove_file(path).is_ok();
        }
        let Ok(executable) = std::env::current_exe() else { return false };
        let Some(parent) = path.parent() else { return false };
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
        // launchd reads ~/Library/LaunchAgents at the next sign-in. Writing
        // through a temporary file avoids leaving a partial property list.
        let staged = path.with_extension(format!("{}.tmp", std::process::id()));
        let result = std::fs::write(&staged, plist(&executable)).and_then(|_| std::fs::rename(&staged, &path));
        if result.is_err() {
            let _ = std::fs::remove_file(staged);
        }
        result.is_ok()
    }

    #[cfg(test)]
    mod tests {
        use super::{managed_plist, plist, refresh_at};
        use std::path::Path;

        #[test]
        fn migration_only_updates_unmodified_opted_in_legacy_agent() {
            let dir = std::env::temp_dir().join(format!("mac-downloader-autostart-test-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let agent = dir.join("agent.plist");
            let old = dir.join("Ezoo Download.app/Contents/MacOS/EzooDownload");
            let new = dir.join("Mac Downloader.app/Contents/MacOS/MacDownloader");
            assert!(!refresh_at(&agent, &new));
            assert!(!agent.exists());
            for legacy in [managed_plist(&old, false), managed_plist(&new, false), managed_plist(&old, true)] {
                std::fs::write(&agent, legacy).unwrap();
                assert!(refresh_at(&agent, &new));
                assert_eq!(std::fs::read_to_string(&agent).unwrap(), plist(&new));
                assert!(!refresh_at(&agent, &new));
            }
            for custom in ["custom agent".to_owned(), managed_plist(&new, false).replace("<key>RunAtLoad</key><true/>", "<key>RunAtLoad</key><false/>") ] {
                std::fs::write(&agent, &custom).unwrap();
                assert!(!refresh_at(&agent, &new));
                assert_eq!(std::fs::read_to_string(&agent).unwrap(), custom);
            }
            std::fs::write(&agent, managed_plist(&old, false)).unwrap();
            let other = dir.join("Other.app/Contents/MacOS/MacDownloader");
            assert!(!refresh_at(&agent, &other));
            assert_eq!(std::fs::read_to_string(&agent).unwrap(), managed_plist(&old, false));
            std::fs::remove_dir_all(dir).unwrap();
        }

        #[test]
        fn launch_agent_escapes_paths_and_starts_quietly_without_respawning_after_quit() {
            let value = plist(Path::new("/Applications/Ezoo & <Friends> \"quoted\".app/Contents/MacOS/EzooDownload"));
            assert!(value.contains("Ezoo &amp; &lt;Friends&gt; &quot;quoted&quot;.app"));
            assert!(value.contains("<key>RunAtLoad</key><true/>"));
            assert!(value.contains("<string>--background</string>"));
            assert!(!value.contains("KeepAlive"));
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    pub fn is_enabled() -> bool {
        false
    }
    pub fn set(_enabled: bool) -> bool {
        false
    }
    pub fn installed_by_setup() -> bool {
        false
    }
    pub fn refresh_legacy_path() {}
}

pub use imp::{installed_by_setup, is_enabled, refresh_legacy_path, set};
