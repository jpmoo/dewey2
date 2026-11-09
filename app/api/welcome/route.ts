import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { countUsersWithEmail, createUser, getDistricts, getSchools, logUserEvent } from "@/lib/db";

/**
 * Finish a Google self sign-up: create the partner account for the verified
 * Google email held in the session token. Body: { full_name, nickname, title,
 * school_ids, district_wide }. The account joins the (single) district; choosing
 * district-wide saves every school in it. The client then calls
 * session.update({ action: "complete-signup" }) to sign in as the new account.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  // The email comes from the signed session token, never from the request body.
  const email = session?.user?.pendingSignup?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // A second submit (double click, another tab) must not create a duplicate,
  // which would make the email ambiguous and lock the person out.
  if ((await countUsersWithEmail(email)) > 0) return NextResponse.json({ ok: true });

  const body = await request.json().catch(() => ({}));
  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  if (!fullName) return NextResponse.json({ error: "Please enter your full name." }, { status: 400 });

  const district = (await getDistricts())[0] ?? null;
  const schools = district ? await getSchools(district.id) : [];
  let schoolIds: number[] = [];
  if (schools.length > 0) {
    if (body.district_wide === true) {
      schoolIds = schools.map((s) => s.id);
    } else {
      const valid = new Set(schools.map((s) => s.id));
      schoolIds = Array.isArray(body.school_ids)
        ? body.school_ids.map((v: unknown) => Number(v)).filter((n: number) => valid.has(n))
        : [];
      if (schoolIds.length === 0) {
        return NextResponse.json({ error: "Choose your school, or district-wide." }, { status: 400 });
      }
    }
  }

  try {
    const user = await createUser({
      full_name: fullName,
      nickname: typeof body.nickname === "string" ? body.nickname : null,
      role: typeof body.title === "string" ? body.title : null,
      email,
      system_role: "partner",
      district_id: district?.id ?? null,
      school_ids: schoolIds,
    });
    await logUserEvent({
      userId: user.id,
      actorId: user.id,
      action: "created",
      detail: `role: ${user.system_role} (self sign-up via Google)`,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Couldn't create your account." },
      { status: 400 }
    );
  }
}
