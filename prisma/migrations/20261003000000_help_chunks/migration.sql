-- Help article sections for AI Assistance and Help search (modules/help/help.index.ts).
CREATE TABLE "HelpChunk" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "sectionTitle" TEXT NOT NULL,
    "roles" TEXT[],
    "plans" TEXT[],
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "searchVector" tsvector,
    "embedding" vector(1536),
    "model" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HelpChunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HelpChunk_articleId_idx" ON "HelpChunk"("articleId");

-- Keyword search.
CREATE INDEX "HelpChunk_searchVector_idx" ON "HelpChunk" USING gin ("searchVector");

-- Meaning search. Same settings as AiEmbedding.
CREATE INDEX "HelpChunk_embedding_idx" ON "HelpChunk" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
