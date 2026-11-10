// ABOUTME: Открывает проверку доступности и скачивание собственного доказательства.
// ABOUTME: Artifact ID и знание case ID сами по себе не предоставляют доступа.
import {bugHuntEvidence} from "@/server/bug-hunt-evidence";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=bugHuntEvidence;
export const HEAD=bugHuntEvidence;
