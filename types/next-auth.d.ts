import "next-auth";
import type { SystemRole } from "@/lib/db";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      username: string;
      nickname: string | null;
      system_role: SystemRole;
      district_id: number | null;
      school_id: number | null;
      /** True when an admin is impersonating this user. */
      impersonating: boolean;
      /** Display name of the admin who started impersonating, if any. */
      impersonatorName: string | null;
    };
  }

  interface User {
    id: string;
    username: string;
    nickname: string | null;
    system_role: SystemRole;
    district_id: number | null;
    school_id: number | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    username?: string;
    nickname?: string | null;
    system_role?: SystemRole;
    district_id?: number | null;
    school_id?: number | null;
    /** Original admin's user id while impersonating; absent otherwise. */
    impersonatorId?: string;
    /** Original admin's display name while impersonating. */
    impersonatorName?: string;
  }
}
