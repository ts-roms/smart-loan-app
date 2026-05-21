import { Button, useTour, type TourStep } from "@loan/ui";
import { Compass } from "lucide-react";

/**
 * Drop-in "Take a tour" button. Pass the article id (which doubles as
 * the tour key) and either explicit steps OR let the button look up
 * steps from the help content registry.
 *
 *   <TourButton tourId="loans-list" />
 *
 * The "completed" state reads from localStorage — once a user finishes
 * the tour, the label changes to "Replay tour" so the affordance is
 * still discoverable but the visual noise dies down.
 */
export function TourButton({
  tourId,
  steps,
  size = "sm",
}: {
  tourId: string;
  steps: TourStep[];
  size?: "sm" | "default";
}) {
  const tour = useTour(tourId, steps);
  if (steps.length === 0) return null;
  return (
    <Button size={size} variant="outline" onClick={tour.start}>
      <Compass className="h-3 w-3" />
      {tour.completed ? "Replay tour" : "Take a tour"}
    </Button>
  );
}
