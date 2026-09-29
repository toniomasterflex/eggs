// OBSOLÈTE depuis le 29/09/2026 — ce fichier peut être supprimé.
//
// Avant cette date, chaque créature posée sur l'herbe (ami épinglé, ou une
// des miennes sortie de « Ma collection ») avait sa propre fenêtre Windows
// (label "pin-<id>", routé ici par main.tsx), ce qui plafonnait leur nombre
// à quelques-unes (coût mémoire/GPU d'une fenêtre WebView2 par créature —
// voir l'historique de pin_pet dans src-tauri/src/lib.rs). À la demande
// d'Antoine (plus aucun plafond), toutes les créatures de l'herbe vivent
// maintenant dans UNE SEULE fenêtre partagée ("pets", voir setup_pets côté
// Rust) :
//   - pet/GroundPetsWindow.tsx — la racine de cette fenêtre partagée
//     (routée par main.tsx), qui liste les créatures épinglées et les
//     positions reçues de Rust ("pets-tick"/"pet-placed").
//   - pet/GroundPet.tsx — une créature de l'herbe (bouton, chat, glissement
//     en JS...), rendue une fois par créature par GroundPetsWindow.
//
// Ce fichier n'est plus importé nulle part (voir main.tsx) — laissé en
// place seulement parce que cette session n'a pas pu le supprimer sur
// l'ordinateur d'Antoine (pas d'accès shell côté appareil ce jour-là).
// À supprimer manuellement (clic droit > supprimer, ou `git rm`).
export {};
