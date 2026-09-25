-- CreateTable
CREATE TABLE "playbooks" (
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "playbooks_pkey" PRIMARY KEY ("key")
);

-- AddForeignKey
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
