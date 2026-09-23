import grassUrl from "../assets/grass.png";
import "../App.css"; // fond transparent (html/body/#root)

// Fenêtre décorative, posée sur toute la largeur de l'écran au-dessus de la
// barre des tâches : aucune interaction, juste de l'herbe qui donne
// l'impression que les créatures marchent dessus.
export default function GroundView() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundImage: `url(${grassUrl})`,
        backgroundRepeat: "repeat-x",
        backgroundPosition: "left bottom",
        backgroundSize: "auto 100%",
      }}
    />
  );
}
