#![allow(dead_code)]

use ffmpeg::{format, frame, software};

pub struct FrameConverter {
    scaler: Option<ScalerState>,
    rgba_frame: frame::Video,
}

struct ScalerState {
    context: software::scaling::Context,
    input_format: format::Pixel,
    width: u32,
    height: u32,
}

impl FrameConverter {
    pub fn new() -> Self {
        Self {
            scaler: None,
            rgba_frame: frame::Video::empty(),
        }
    }

    pub fn convert(&mut self, frame: &mut frame::Video) -> Vec<u8> {
        if frame.format() == format::Pixel::RGBA {
            let width = frame.width() as usize;
            let height = frame.height() as usize;
            let stride = frame.stride(0);

            return copy_rgba_plane(frame.data(0), stride, width, height);
        }

        let width = frame.width();
        let height = frame.height();

        self.ensure_scaler(frame.format(), width, height);
        self.ensure_rgba_frame(width, height);

        {
            let rgba_frame = &mut self.rgba_frame;
            self.scaler
                .as_mut()
                .expect("scaler must be initialised")
                .context
                .run(frame, rgba_frame)
                .expect("frame conversion should succeed");
        }

        let rgba_frame = &self.rgba_frame;
        copy_rgba_plane(
            rgba_frame.data(0),
            rgba_frame.stride(0),
            rgba_frame.width() as usize,
            rgba_frame.height() as usize,
        )
    }

    fn ensure_scaler(&mut self, input_format: format::Pixel, width: u32, height: u32) {
        let needs_new = self.scaler.as_ref().is_none_or(|state| {
            state.input_format != input_format || state.width != width || state.height != height
        });

        if needs_new {
            self.scaler = Some(ScalerState {
                context: software::converter((width, height), input_format, format::Pixel::RGBA)
                    .expect("failed to create frame scaler"),
                input_format,
                width,
                height,
            });
            self.ensure_rgba_frame(width, height);
        }
    }

    fn ensure_rgba_frame(&mut self, width: u32, height: u32) {
        if self.rgba_frame.width() != width || self.rgba_frame.height() != height {
            self.rgba_frame = frame::Video::new(format::Pixel::RGBA, width, height);
        }
    }
}

pub fn copy_rgba_plane(data: &[u8], stride: usize, width: usize, height: usize) -> Vec<u8> {
    debug_assert!(stride >= width * 4, "stride too small for RGBA frame");

    let row_len = width * 4;
    let total = row_len * height;

    if stride == row_len && data.len() >= total {
        return data[..total].to_vec();
    }

    let mut frame_buffer = Vec::with_capacity(total);
    for row in data.chunks(stride).take(height) {
        frame_buffer.extend_from_slice(&row[..row_len]);
    }
    frame_buffer
}

#[cfg(target_os = "macos")]
pub fn copy_bgra_to_rgba(data: &[u8], stride: usize, width: usize, height: usize) -> Vec<u8> {
    debug_assert!(stride >= width * 4, "stride too small for BGRA frame");

    let row_len = width * 4;
    let total = row_len * height;
    let mut frame_buffer = vec![0u8; total];

    let mut dst_offset = 0;
    for row in data.chunks(stride).take(height) {
        let src = &row[..row_len];
        let dst = &mut frame_buffer[dst_offset..dst_offset + row_len];

        for (d, s) in dst
            .as_chunks_mut::<32>()
            .0
            .iter_mut()
            .zip(src.as_chunks::<32>().0.iter())
        {
            d[0] = s[2];
            d[1] = s[1];
            d[2] = s[0];
            d[3] = s[3];
            d[4] = s[6];
            d[5] = s[5];
            d[6] = s[4];
            d[7] = s[7];
            d[8] = s[10];
            d[9] = s[9];
            d[10] = s[8];
            d[11] = s[11];
            d[12] = s[14];
            d[13] = s[13];
            d[14] = s[12];
            d[15] = s[15];
            d[16] = s[18];
            d[17] = s[17];
            d[18] = s[16];
            d[19] = s[19];
            d[20] = s[22];
            d[21] = s[21];
            d[22] = s[20];
            d[23] = s[23];
            d[24] = s[26];
            d[25] = s[25];
            d[26] = s[24];
            d[27] = s[27];
            d[28] = s[30];
            d[29] = s[29];
            d[30] = s[28];
            d[31] = s[31];
        }

        let processed = (row_len / 32) * 32;
        for (d, s) in dst[processed..]
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(src[processed..].as_chunks::<4>().0.iter())
        {
            d[0] = s[2];
            d[1] = s[1];
            d[2] = s[0];
            d[3] = s[3];
        }

        dst_offset += row_len;
    }

    frame_buffer
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::copy_bgra_to_rgba;

    #[test]
    fn copies_padded_rows_and_partial_chunks() {
        for width in [1, 7, 8, 9, 17] {
            let stride = width * 4 + 5;
            let mut data = vec![0u8; stride * 2];
            let mut expected = Vec::new();
            for row in 0..2 {
                for pixel in 0..width {
                    let offset = row * stride + pixel * 4;
                    let blue = (row * 20 + pixel) as u8;
                    data[offset..offset + 4].copy_from_slice(&[blue, 33, 66, 255]);
                    expected.extend_from_slice(&[66, 33, blue, 255]);
                }
            }
            assert_eq!(copy_bgra_to_rgba(&data, stride, width, 2), expected);
        }
    }
}
