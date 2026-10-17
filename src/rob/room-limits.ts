// The membership bounds, declared once. They live in their own module because
// two files need them: room.ts validates against them, and room-text.ts renders
// the rejection message from them. room.ts value-imports room-text.ts, so
// room-text.ts must not value-import room.ts — this module is the shared leaf
// that keeps that edge one-way.
export const ROOM_MIN_MEMBERS = 2;
export const ROOM_MAX_MEMBERS = 20;
