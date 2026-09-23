// Machine à états du poussin. Aucune animation ici : seulement les règles.
// Utilisée par mon pet ET par chaque pet d'ami épinglé.

export type PetPhase =
  | "HIDDEN"
  | "ARRIVING"
  | "VISIBLE"
  | "INTERACTING"
  | "DRAGGING" // seulement pour les pets épinglés : on est en train de le déplacer
  | "EXITING";

export type PetEvent =
  | { type: "ZONE_ENTER" } // la souris entre dans la zone
  | { type: "ZONE_LEAVE" } // la souris s'éloigne
  | { type: "ARRIVED" } // fin de l'animation d'arrivée
  | { type: "CLICK" } // clic sur le poussin
  | { type: "INTERACTION_DONE" } // fin de la réaction
  | { type: "DRAG_START" } // début du déplacement
  | { type: "DRAG_END" } // fin du déplacement
  | { type: "EXITED" }; // fin de l'animation de départ

export interface PetState {
  phase: PetPhase;
  inZone: boolean; // la souris est-elle encore dans la zone ?
}

export const initialPetState: PetState = { phase: "HIDDEN", inZone: false };

export function petReducer(state: PetState, event: PetEvent): PetState {
  switch (event.type) {
    case "ZONE_ENTER": {
      const next = { ...state, inZone: true };
      // Seulement si caché. Sinon on note juste que la souris est là.
      return state.phase === "HIDDEN" ? { ...next, phase: "ARRIVING" } : next;
    }

    case "ZONE_LEAVE": {
      const next = { ...state, inZone: false };
      // Si le poussin est en train d'arriver, de réagir ou d'être déplacé, il finit
      // d'abord, puis repart. Jamais de demi-tour au milieu d'une animation.
      return state.phase === "VISIBLE" ? { ...next, phase: "EXITING" } : next;
    }

    case "ARRIVED":
      if (state.phase !== "ARRIVING") return state;
      return { ...state, phase: state.inZone ? "VISIBLE" : "EXITING" };

    case "CLICK":
      if (state.phase !== "VISIBLE") return state;
      return { ...state, phase: "INTERACTING" };

    case "INTERACTION_DONE":
      if (state.phase !== "INTERACTING") return state;
      return { ...state, phase: state.inZone ? "VISIBLE" : "EXITING" };

    case "DRAG_START":
      if (state.phase !== "VISIBLE") return state;
      return { ...state, phase: "DRAGGING" };

    case "DRAG_END":
      if (state.phase !== "DRAGGING") return state;
      return { ...state, phase: state.inZone ? "VISIBLE" : "EXITING" };

    case "EXITED":
      if (state.phase !== "EXITING") return state;
      // Si la souris est revenue pendant le départ, il revient après.
      return { ...state, phase: state.inZone ? "ARRIVING" : "HIDDEN" };

    default:
      return state;
  }
}