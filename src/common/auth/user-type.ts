export const USER_TYPES = {
  ADMIN: 'ADMIN',
  USER: 'USER',
} as const;

export type UserType = (typeof USER_TYPES)[keyof typeof USER_TYPES];

export function isAdminUserType(userType?: UserType): boolean {
  return userType === USER_TYPES.ADMIN;
}
