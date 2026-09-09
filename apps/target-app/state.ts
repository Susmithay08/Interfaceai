/**
 * Synthetic data only. No real names, no real account numbers, no real institution.
 * This app is a stand-in for a legacy core-banking teller screen.
 */

export interface Account {
  readonly type: string;
  readonly number: string;
  readonly balance: string;
}

export interface Member {
  readonly id: string;
  readonly name: string;
  readonly accounts: readonly Account[];
}

export const MEMBERS: Readonly<Record<string, Member>> = {
  "100234": {
    id: "100234",
    name: "Dana Whitfield",
    accounts: [
      { type: "Savings", number: "*******4417", balance: "$4,182.55" },
      { type: "Checking", number: "*******9021", balance: "$912.10" },
    ],
  },
  "100999": {
    id: "100999",
    name: "Ray Okonkwo",
    accounts: [
      { type: "Savings", number: "*******7788", balance: "$210.00" },
      { type: "Checking", number: "*******7789", balance: "$1,045.00" },
    ],
  },
};

export const MEMBER_ID_PATTERN = /^[0-9]{6}$/;

export function findMembers(memberId: string): Member[] {
  const hit = MEMBERS[memberId];
  return hit ? [hit] : [];
}
