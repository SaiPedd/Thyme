// The one place that decides who sees what. Every outbound message declares an audience and
// a sensitivity, and passes through project() before it reaches the outbox.
//
// Rules:
// - "household" content (shared items, shared splits, household totals) may go to the group.
// - "personal" content (personal items, allergies, balances, ledger details) goes ONLY to the DM
//   of the member it is about. Sending it to the group, or to another member, is refused.
// - HOUSEHOLD_MODE=dm (or no group chat known yet): a group audience fans out to every member's DM.

import type { Destination } from "../adapters/types";
import type { Household, Member } from "../domain/household";

export type Audience = { kind: "group" } | { kind: "member"; memberId: number };
export type Sensitivity = "household" | "personal";

export interface Draft {
  audience: Audience;
  text: string;
  sensitivity: Sensitivity;
  /** For personal content: the member it is about. Required when sensitivity is "personal". */
  subjectMemberId?: number;
}

export class PrivacyError extends Error {}

export function project(draft: Draft, household: Household, members: Member[]): Destination[] {
  if (draft.sensitivity === "personal") {
    if (draft.audience.kind !== "member") throw new PrivacyError("personal content can't go to the group");
    if (draft.subjectMemberId === undefined) throw new PrivacyError("personal content needs a subject member");
    if (draft.subjectMemberId !== draft.audience.memberId) {
      throw new PrivacyError("personal content can only go to the member it is about");
    }
  }

  if (draft.audience.kind === "member") {
    const memberId = draft.audience.memberId;
    const m = members.find((x) => x.id === memberId && x.household_id === household.id);
    if (!m) throw new PrivacyError("recipient is not a household member");
    return [{ kind: "member", phone: m.phone }];
  }

  if (household.mode === "group" && household.chat_id) return [{ kind: "group", chatId: household.chat_id }];
  return members.filter((m) => m.household_id === household.id).map((m) => ({ kind: "member", phone: m.phone }));
}
