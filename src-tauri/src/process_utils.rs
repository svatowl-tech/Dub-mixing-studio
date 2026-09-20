#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub const CREATE_NO_WINDOW: u32 = 0x08000000;

pub trait CommandExtHide {
    fn hide_window(&mut self) -> &mut Self;
}

impl CommandExtHide for std::process::Command {
    fn hide_window(&mut self) -> &mut Self {
        #[cfg(target_os = "windows")]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl CommandExtHide for tokio::process::Command {
    fn hide_window(&mut self) -> &mut Self {
        #[cfg(target_os = "windows")]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}
