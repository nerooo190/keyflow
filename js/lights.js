// Key-light protocols for light-up keyboards (MIDI out).
// The proprietary formats were determined for interoperability (lighting the user's own keyboard);
// only the message formats are used here, no third-party code.
//
//  vangoa  F0 4D 4C 4E 45 <note> <1|0> F7                  (MUSTAR MEP-4000 "Dight Piano", Vangoa, other Medeli-based boards)
//  one     init F0 00 20 2B 69 00 00 55 79 F7, F0 00 20 2B 69 16 02 00 F7; key: A2 <note-21> <1|2 colour, 0 off>
//  casio   init F0 44 7E 7E 7F 00 03 F7, F0 44 7E 7E 7F 00 06 00 F7; key: F0 44 7E 7E 7F 02 00 <note> <1|0> F7
//  chN     Note On/Off on channel N (optionally CC7=0 on that channel so the lights stay silent)
//  finger  channel by finger: LH fingers 1-5 → ch 1-5, RH fingers 1-5 → ch 6-10 (no finger info: LH ch 11, RH ch 12)

export const LIGHT_PROTOCOLS = [
  { id: 'off', label: 'Off' },
  { id: 'vangoa', label: 'Proprietary 3 – Vangoa / MUSTAR MEP-4000 (recommended)', sysex: true },
  { id: 'one', label: 'Proprietary 1 – ONE Smart Piano, Piano LED Plus', sysex: true },
  { id: 'casio', label: 'Proprietary 2 – Casiotone LK-S250', sysex: true },
  { id: 'finger', label: 'Channel per finger – iPiano Model-U' },
  ...Array.from({ length: 16 }, (_, i) => ({
    id: 'ch' + (i + 1),
    label: `Channel ${i + 1}` + (i === 0 ? ' – most Yamaha, some Casio' : i === 2 ? ' – most Casio, AKAI' : ''),
    channel: i,
  })),
];

const inPianoRange = (p) => p >= 21 && p <= 108;

export function protocol(id) {
  return LIGHT_PROTOCOLS.find((x) => x.id === id) || LIGHT_PROTOCOLS[0];
}

/** Messages to send once when a protocol is activated. */
export function initMessages(id, { silent = true } = {}) {
  const pr = protocol(id);
  if (id === 'one') return [[0xf0, 0x00, 0x20, 0x2b, 0x69, 0x00, 0x00, 0x55, 0x79, 0xf7], [0xf0, 0x00, 0x20, 0x2b, 0x69, 0x16, 0x02, 0x00, 0xf7]];
  if (id === 'casio') return [[0xf0, 0x44, 0x7e, 0x7e, 0x7f, 0x00, 0x03, 0xf7], [0xf0, 0x44, 0x7e, 0x7e, 0x7f, 0x00, 0x06, 0x00, 0xf7]];
  if (pr.channel != null && silent) return [[0xb0 | pr.channel, 7, 0]]; // volume 0 → light without sound
  if (id === 'finger' && silent) return Array.from({ length: 12 }, (_, c) => [0xb0 | c, 7, 0]);
  return [];
}

const fingerChannel = (h, f) => (h === 'L' ? (f ? f - 1 : 10) : f ? 4 + f : 11);

/** Messages that switch the light of one key on or off. info = {h: 'L'|'R', f: 1-5}. */
export function keyMessages(id, p, on, info = {}) {
  const pr = protocol(id);
  switch (id) {
    case 'off':
      return [];
    case 'vangoa':
      return inPianoRange(p) ? [[0xf0, 0x4d, 0x4c, 0x4e, 0x45, p, on ? 1 : 0, 0xf7]] : [];
    case 'casio':
      return inPianoRange(p) ? [[0xf0, 0x44, 0x7e, 0x7e, 0x7f, 0x02, 0x00, p, on ? 1 : 0, 0xf7]] : [];
    case 'one':
      return inPianoRange(p) ? [[0xa2, p - 21, on ? (info.h === 'L' ? 2 : 1) : 0]] : [];
    case 'finger': {
      const ch = fingerChannel(info.h, info.f);
      return [on ? [0x90 | ch, p, 64] : [0x80 | ch, p, 0]];
    }
    default:
      return pr.channel != null ? [on ? [0x90 | pr.channel, p, 64] : [0x80 | pr.channel, p, 0]] : [];
  }
}

/** MIDI channels a protocol lights on (incoming notes there may be echoes of our own lights). */
export function lightChannels(id) {
  const pr = protocol(id);
  if (pr.channel != null) return new Set([pr.channel]);
  if (id === 'finger') return new Set(Array.from({ length: 12 }, (_, i) => i));
  return new Set();
}
