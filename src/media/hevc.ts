export function splitNALs(data: Buffer): Buffer[] {
    const starts: { offset: number; size: number }[] = [];
    for (let i = 0; i + 3 <= data.length; i++) {
        if (data[i] || data[i + 1]) continue;
        const size = data[i + 2] === 1 ? 3 : i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
        if (size) { starts.push({ offset: i, size }); i += size - 1; }
    }
    return starts.map((s, i) => data.subarray(s.offset + s.size, starts[i + 1]?.offset ?? data.length))
        .filter(nal => nal.length >= 2);
}
export const nalType = (nal: Buffer) => (nal[0] >> 1) & 63;

// Decode only the early SPS fields needed for display dimensions, including
// the conformance window. No decoding of video pixels is involved.
export function resolution(sps: Buffer): { width: number; height: number } {
    const bytes: number[] = [];
    for (let i = 2; i < sps.length; i++) {
        if (i >= 4 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
        bytes.push(sps[i]);
    }
    let pos = 0;
    const bits = (n: number): number => {
        if (pos + n > bytes.length * 8) throw new Error('Truncated H.265 SPS');
        let v = 0;
        while (n--) { v = v * 2 + ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1); pos++; }
        return v;
    };
    const skip = (n: number) => { bits(n); };
    const ue = (): number => {
        let zeros = 0;
        while (!bits(1)) if (++zeros > 30) throw new Error('Invalid SPS Exp-Golomb');
        return 2 ** zeros - 1 + bits(zeros);
    };
    skip(4); const sublayers = bits(3); skip(1);
    skip(96); // general profile_tier_level
    const profiles: number[] = [], levels: number[] = [];
    for (let i = 0; i < sublayers; i++) { profiles.push(bits(1)); levels.push(bits(1)); }
    if (sublayers) skip((8 - sublayers) * 2);
    for (let i = 0; i < sublayers; i++) { if (profiles[i]) skip(88); if (levels[i]) skip(8); }
    ue(); const chroma = ue();
    if (chroma > 3) throw new Error('Invalid SPS chroma format');
    const separate = chroma === 3 ? bits(1) : 0;
    let width = ue(), height = ue();
    if (bits(1)) {
        const x = !separate && (chroma === 1 || chroma === 2) ? 2 : 1;
        const y = !separate && chroma === 1 ? 2 : 1;
        width -= x * (ue() + ue()); height -= y * (ue() + ue());
    }
    if (width <= 0 || height <= 0 || width > 65535 || height > 65535) throw new Error('Invalid SPS resolution');
    return { width, height };
}

