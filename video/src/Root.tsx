import { Composition } from "remotion";
import { Promo } from "./Promo";
import { RELEASE_030_FRAMES, Release030 } from "./Release030";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Promo"
        component={Promo}
        durationInFrames={1350}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Release030"
        component={Release030}
        durationInFrames={RELEASE_030_FRAMES}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ locale: "en" }}
      />
      <Composition
        id="Release030Zh"
        component={Release030}
        durationInFrames={RELEASE_030_FRAMES}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ locale: "zh" }}
      />
    </>
  );
};
