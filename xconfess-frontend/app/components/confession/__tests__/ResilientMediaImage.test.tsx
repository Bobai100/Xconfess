import { fireEvent, render, screen } from "@testing-library/react";
import { ResilientMediaImage } from "../ResilientMediaImage";

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} />,
}));

describe("ResilientMediaImage", () => {
  it("keeps its containing geometry and offers an accessible retry after failure", () => {
    render(
      <ResilientMediaImage
        src="https://media.example.test/upload.jpg"
        alt="Confession media attachment"
        sizes="100vw"
        aspectRatio={16 / 9}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Confession media attachment" }));

    expect(screen.getByText("Image unavailable: Confession media attachment")).toBeInTheDocument();
    expect(screen.getByTestId("media-geometry-box")).toHaveStyle({ aspectRatio: "16 / 9" });

    fireEvent.click(screen.getByRole("button", { name: "Retry image" }));

    expect(screen.getByRole("img", { name: "Confession media attachment" })).toBeInTheDocument();
    expect(screen.getByTestId("media-geometry-box")).toHaveStyle({ aspectRatio: "16 / 9" });
  });

  it("uses a stable fallback ratio when media metadata is invalid", () => {
    render(
      <ResilientMediaImage
        src="https://media.example.test/upload.jpg"
        alt="Confession media attachment"
        sizes="100vw"
        aspectRatio={0}
      />,
    );

    expect(screen.getByTestId("media-geometry-box")).toHaveStyle({ aspectRatio: "16 / 9" });
  });
});
