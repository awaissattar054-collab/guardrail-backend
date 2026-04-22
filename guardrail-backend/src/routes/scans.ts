import { Router } from "express";
import { db, scansTable, findingsTable } from "../db.js";
import { eq, desc, avg, count, sql } from "drizzle-orm";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const router = Router();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function runScanAnalysis(scanId: number, url: string) {
  try {
    await db.update(scansTable).set({ status: "analyzing" }).where(eq(scansTable.id, scanId));

    const prompt = `You are a compliance analysis AI. Analyze the website at "${url}" for legal, privacy, and carbon-emission compliance issues.

Provide a comprehensive compliance report in valid JSON format with this exact structure:
{
  "legalScore": <number 0-100>,
  "privacyScore": <number 0-100>,
  "carbonScore": <number 0-100>,
  "findings": [
    {
      "category": "<legal|privacy|carbon>",
      "severity": "<critical|high|medium|low|info>",
      "title": "<concise issue title>",
      "description": "<detailed description>",
      "recommendation": "<specific actionable recommendation>"
    }
  ]
}

Provide 6-12 findings total. Return ONLY valid JSON, no markdown.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const rawText = response.text ?? "{}";
    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { legalScore: 50, privacyScore: 50, carbonScore: 50, findings: [] };
    }

    const legalScore = Math.max(0, Math.min(100, parsed.legalScore ?? 50));
    const privacyScore = Math.max(0, Math.min(100, parsed.privacyScore ?? 50));
    const carbonScore = Math.max(0, Math.min(100, parsed.carbonScore ?? 50));
    const overallScore = Math.round((legalScore + privacyScore + carbonScore) / 3);

    await db.update(scansTable).set({
      status: "completed",
      legalScore,
      privacyScore,
      carbonScore,
      overallScore,
      completedAt: new Date().toISOString(),
    }).where(eq(scansTable.id, scanId));

    if (Array.isArray(parsed.findings)) {
      const validFindings = parsed.findings
        .filter((f: any) =>
          ["legal", "privacy", "carbon"].includes(f.category) &&
          ["critical", "high", "medium", "low", "info"].includes(f.severity) &&
          f.title && f.description && f.recommendation
        )
        .map((f: any) => ({
          scanId,
          category: f.category,
          severity: f.severity,
          title: String(f.title).slice(0, 200),
          description: String(f.description).slice(0, 2000),
          recommendation: String(f.recommendation).slice(0, 2000),
        }));

      if (validFindings.length > 0) {
        await db.insert(findingsTable).values(validFindings);
      }
    }
  } catch (err) {
    await db.update(scansTable).set({
      status: "failed",
      errorMessage: err instanceof Error ? err.message : "Analysis failed",
    }).where(eq(scansTable.id, scanId));
  }
}

// GET /api/scans
router.get("/scans", async (req, res) => {
  const scans = await db.select().from(scansTable).orderBy(desc(scansTable.createdAt));
  res.json(scans);
});

// POST /api/scans
router.post("/scans", async (req, res) => {
  const schema = z.object({ url: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid URL provided" });
    return;
  }

  let { url } = parsed.data;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  try { new URL(url); } catch {
    res.status(400).json({ error: "Invalid URL format" });
    return;
  }

  const [scan] = await db.insert(scansTable).values({ url, status: "pending" }).returning();
  res.status(201).json(scan);
  setImmediate(() => runScanAnalysis(scan.id, url));
});

// GET /api/scans/summary
router.get("/scans/summary", async (req, res) => {
  const [stats] = await db.select({
    totalScans: count(),
    completedScans: sql<number>`count(*) filter (where status = 'completed')`,
    avgLegalScore: avg(scansTable.legalScore),
    avgPrivacyScore: avg(scansTable.privacyScore),
    avgCarbonScore: avg(scansTable.carbonScore),
  }).from(scansTable);

  const [findingStats] = await db.select({
    criticalFindings: sql<number>`count(*) filter (where severity = 'critical')`,
  }).from(findingsTable);

  res.json({
    totalScans: Number(stats.totalScans),
    completedScans: Number(stats.completedScans),
    avgLegalScore: stats.avgLegalScore ? Math.round(Number(stats.avgLegalScore)) : null,
    avgPrivacyScore: stats.avgPrivacyScore ? Math.round(Number(stats.avgPrivacyScore)) : null,
    avgCarbonScore: stats.avgCarbonScore ? Math.round(Number(stats.avgCarbonScore)) : null,
    criticalFindings: Number(findingStats?.criticalFindings ?? 0),
  });
});

// GET /api/scans/:id
router.get("/scans/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [scan] = await db.select().from(scansTable).where(eq(scansTable.id, id));
  if (!scan) { res.status(404).json({ error: "Scan not found" }); return; }

  const findings = await db.select().from(findingsTable).where(eq(findingsTable.scanId, id));
  res.json({ ...scan, findings });
});

// DELETE /api/scans/:id
router.delete("/scans/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [deleted] = await db.delete(scansTable).where(eq(scansTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Scan not found" }); return; }

  res.status(204).end();
});

export default router;
