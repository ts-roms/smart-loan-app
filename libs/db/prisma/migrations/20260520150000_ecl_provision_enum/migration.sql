-- Add ECL_PROVISION to the JournalSource enum so EclRepository.run can
-- post DR Impairment Loss / CR Allowance entries tagged with this source.
ALTER TYPE "JournalSource" ADD VALUE 'ECL_PROVISION';
