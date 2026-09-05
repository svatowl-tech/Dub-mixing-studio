fn main() {
    let mut meter = ebur128::EbuR128::new(1, 44100, ebur128::Mode::S).unwrap();
    println!("{:?}", meter.loudness_shortterm());
}
