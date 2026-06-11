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
  }
}
