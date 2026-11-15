import { describe, expect, test } from "bun:test";
import type { Household, Member } from "../src/domain/household";
import { PrivacyError, project } from "../src/privacy/projection";

const members: Member[] = [
  { id: 1, household_id: 1, phone: "+16095550101", name: "A" },
  { id: 2, household_id: 1, phone: "+16095550102", name: "B" },
  { id: 3, household_id: 1, phone: "+16095550103", name: "C" },
];
const groupHouse: Household = { id: 1, name: "h", chat_id: "chat-1", tz: "America/New_York", mode: "group" };
const dmHouse: Household = { ...groupHouse, mode: "dm" };

describe("projection", () => {
  test("household content to the group goes to the group chat", () => {
    expect(project({ audience: { kind: "group" }, text: "x", sensitivity: "household" }, groupHouse, members)).toEqual([
      { kind: "group", chatId: "chat-1" },
    ]);
  });

  test("the group NEVER receives personal content", () => {
    for (const house of [groupHouse, dmHouse]) {
      expect(() =>
        project({ audience: { kind: "group" }, text: "your balance", sensitivity: "personal", subjectMemberId: 1 }, house, members),
      ).toThrow(PrivacyError);
    }
  });

  test("personal content only reaches the member it is about", () => {
    expect(
      project({ audience: { kind: "member", memberId: 2 }, text: "x", sensitivity: "personal", subjectMemberId: 2 }, groupHouse, members),
    ).toEqual([{ kind: "member", phone: "+16095550102" }]);
    expect(() =>
      project({ audience: { kind: "member", memberId: 3 }, text: "x", sensitivity: "personal", subjectMemberId: 2 }, groupHouse, members),
    ).toThrow(PrivacyError);
    expect(() => project({ audience: { kind: "member", memberId: 2 }, text: "x", sensitivity: "personal" }, groupHouse, members)).toThrow(
      PrivacyError,
    );
  });

  test("dm mode, or no known group chat, fans group messages out to every member", () => {
    const out = project({ audience: { kind: "group" }, text: "x", sensitivity: "household" }, dmHouse, members);
    expect(out).toEqual(members.map((m) => ({ kind: "member", phone: m.phone })));
    const noChat = project({ audience: { kind: "group" }, text: "x", sensitivity: "household" }, { ...groupHouse, chat_id: null }, members);
    expect(noChat).toHaveLength(3);
  });

  test("non-members can't be addressed", () => {
    expect(() => project({ audience: { kind: "member", memberId: 99 }, text: "x", sensitivity: "household" }, groupHouse, members)).toThrow(
      PrivacyError,
    );
  });
});
