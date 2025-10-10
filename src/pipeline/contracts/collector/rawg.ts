export interface CollectProcessedDataOptions {
  monthsBack?: number;
  monthsForward?: number;
  limitMonths?: number;
  ordering?: '-released' | '-added';
  metacritic?: string;
}
