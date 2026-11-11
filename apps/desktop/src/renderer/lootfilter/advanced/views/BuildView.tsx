import type { LfNav } from '../../LootFilterArea';
import { BuildFilterWizard } from '../../buildfilter/Wizard';

/** The Advanced rail's Build view: the Build Filter wizard (your build, stages, preview). */
export function BuildView({ nav }: { nav: LfNav }) {
  return <BuildFilterWizard nav={nav} />;
}
