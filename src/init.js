export const init = (width, heigth, camera, render) => {
  window.addEventListener("resize", () => {
    width = window.innerWidth;
    heigth = window.innerHeight;

    // cam
    camera.aspect = width / heigth;
    camera.updateProjectionMatrix();

    render.setSize(width, heigth);
  });
};
